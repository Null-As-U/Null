// ==UserScript==
// @name         RUMI - Zendesk
// @namespace    http://tampermonkey.net/
// @version      1.0
// @description  Null
// @author       Null
// @match        *://*.zendesk.com/*
// @grant        GM_openInTab
// @grant        window.close
// @run-at       document-end
// ==/UserScript==

(function () {
    'use strict';

    // Opens Apollo in a background tab without stealing focus.
    //
    // STRATEGY:
    // - If a pre-opened window reference is provided (opened synchronously in the click handler
    //   BEFORE any awaits, while still in the user-gesture context), we navigate it to the real
    //   URL. This keeps Zendesk focused AND sets window.opener so Apollo can self-close.
    // - If no pre-opened window is provided (e.g. cache-hit path where we call this directly),
    //   we fall back to GM_openInTab with setParent:true.
    //
    // IMPORTANT: window.open() used to pre-open about:blank must be called SYNCHRONOUSLY
    // inside a click handler before any await. After any await the gesture context expires
    // and window.focus() can no longer restore Zendesk focus reliably.
    //
    // @param {string} url                        - Final URL to navigate to.
    // @param {Window|null} [preOpenedWindow=null] - A window already opened via window.open()
    //                                              in the user-gesture context, if available.
    function openBackgroundTab(url) {
        if (typeof GM_openInTab !== 'undefined') {
            try {
                const tab = GM_openInTab(url, { active: false, insert: true, setParent: true });
                RUMIApolloTabManager.register(tab);
                return tab;
            } catch (e) {
                GM_openInTab(url, true);
                return null;
            }
        }
        const w = window.open(url, '_blank');
        if (w) { w.blur(); window.focus(); }
        return null;
    }

    // Opens Apollo in the foreground (only for explicit Apollo button clicks).
    function openForegroundTab(url) {
        if (typeof GM_openInTab !== 'undefined') {
            try {
                const tab = GM_openInTab(url, { active: true, insert: true, setParent: true });
                RUMIApolloTabManager.register(tab);
                return tab;
            } catch (e) {
                GM_openInTab(url, true);
                return null;
            }
        }
        const w = window.open(url, '_blank');
        if (w) { try { w.focus(); } catch (_) { } }
        return null;
    }

    const RUMIApolloTabManager = {
        _openTabs: [],
        _listenerKey: null,

        register(tabHandle) {
            if (!tabHandle) return;
            this._openTabs.push(tabHandle);
            tabHandle.onclose = () => {
                this._openTabs = this._openTabs.filter(t => t !== tabHandle);
                console.log('RUMI: Apollo tab closed manually. Remaining:', this._openTabs.length);
            };
            this._ensureListener();
        },

        _ensureListener() {
            if (this._listenerKey !== null) return;
            if (typeof GM_addValueChangeListener === 'undefined') {
                console.warn('RUMI: GM_addValueChangeListener not available. Auto-close disabled.');
                return;
            }
            this._listenerKey = GM_addValueChangeListener(
                'rumi_apollo_close_signal',
                (name, oldVal, newVal, remote) => {
                    if (!remote) return;
                    console.log('RUMI: Received Apollo close signal.');
                    this._closeLatestTab();
                }
            );
            console.log('RUMI: Apollo tab close listener registered.');
        },

        _closeLatestTab() {
            if (this._openTabs.length === 0) {
                console.warn('RUMI: Close signal received but no tracked Apollo tabs.');
                return;
            }
            const tab = this._openTabs.pop();
            try {
                tab.close();
                console.log('RUMI: Apollo tab closed via external signal.');
            } catch (e) {
                console.error('RUMI: Failed to close Apollo tab:', e);
            }
        }
    };

    // Core variables needed for RUMI
    let username = '';
    let observerDisconnected = false;
    let fieldVisibilityState = 'all'; // 'all' or 'minimal'
    let globalButton = null;

    // Minimal RUMI Enhancement State Stub to prevent ReferenceErrors in API and Log modules
    const rumiEnhancement = {
        currentLogLevel: 2,
        automationLogs: [],
        config: {
            logging: { verbose: false, advancedStats: false },
            CIRCUIT_BREAKER_THRESHOLD: 10,
            MAX_RETRIES: 2,
            RATE_LIMIT: 200
        },
        consecutiveErrors: 0,
        apiCallCount: 0,
        stats: { totalAutomated: 0, manualProcessed: 0 },
        isDryRun: false,
        isMonitoring: false,
        cityToCountry: new Map(),
        lastApiReset: Date.now()
    };

    // Performance optimization variables
    let debounceTimers = new Map();

    // Configuration object for timing and cache management
    const config = {
        timing: {
            cacheMaxAge: 5000
        }
    };

    // Function to load field visibility state from localStorage
    function loadFieldVisibilityState() {
        const savedState = localStorage.getItem('zendesk_field_visibility_state');
        if (savedState && (savedState === 'all' || savedState === 'minimal')) {
            fieldVisibilityState = savedState;
            console.log(`🔐 Field visibility state loaded from storage: ${fieldVisibilityState}`);
        } else {
            fieldVisibilityState = 'all';
            console.log(`🔐 Using default field visibility state: ${fieldVisibilityState}`);
        }
    }

    function saveFieldVisibilityState() {
        localStorage.setItem('zendesk_field_visibility_state', fieldVisibilityState);
        console.log(`💾 Field visibility state saved: ${fieldVisibilityState}`);
    }

    let applyFieldVisibilityTimeout = null;
    let isApplyingFieldVisibility = false;

    function applyFieldVisibilityState(retryCount = 0) {
        if (isApplyingFieldVisibility) {
            console.debug('⏭️ Skipping applyFieldVisibilityState - already in progress');
            return;
        }
        if (retryCount === 0) {
            if (applyFieldVisibilityTimeout) clearTimeout(applyFieldVisibilityTimeout);
            applyFieldVisibilityTimeout = setTimeout(() => applyFieldVisibilityStateInternal(retryCount), 100);
            return;
        }
        applyFieldVisibilityStateInternal(retryCount);
    }

    function applyFieldVisibilityStateInternal(retryCount = 0) {
        isApplyingFieldVisibility = true;
        let allForms = getActiveTicketForms('section.grid-ticket-fields-panel', true, 2000);
        if (allForms.length === 0) {
            const formSelectors = [
                'section[class*="ticket-fields"]',
                '[data-test-id*="TicketFieldsPane"]',
                '.ticket_fields',
                'form',
                '[class*="form"]',
                'div[class*="ticket-field"]'
            ];
            for (const selector of formSelectors) {
                allForms = getActiveTicketForms(selector, false, 1000);
                if (allForms.length > 0) { console.log(`📋 Found VISIBLE forms using selector: ${selector}`); break; }
            }
        }
        if (allForms.length === 0) {
            if (retryCount < 3) {
                console.warn(`⚠️ No forms found for field visibility control. Retrying... (attempt ${retryCount + 1}/3)`);
                isApplyingFieldVisibility = false;
                setTimeout(() => applyFieldVisibilityState(retryCount + 1), 1000);
                return;
            } else {
                console.warn('⚠️ No forms found for field visibility control after 3 attempts.');
                isApplyingFieldVisibility = false;
                return;
            }
        }
        // console.log(`🔄 Applying field visibility state: ${fieldVisibilityState}`);
        requestAnimationFrame(() => {
            allForms.forEach(form => {
                if (!form || !form.children || !form.isConnected) return;
                const allPossibleFields = Array.from(form.querySelectorAll('[data-garden-id="forms.field"], .StyledField-sc-12gzfsu-0, [class*="field"], [data-test-id*="field"], div:has(label)'));
                const fields = [];
                allPossibleFields.forEach(field => {
                    try {
                        if (field.nodeType !== Node.ELEMENT_NODE || !field.isConnected || !field.querySelector('label')) return;
                        if (isSystemField(field)) return;
                        if (fields.includes(field)) return;
                        fields.push(field);
                    } catch (e) { console.debug('Error processing field:', field, e); }
                });
                const fieldsToHide = [];
                const fieldsToShow = [];
                fields.forEach(field => {
                    try {
                        if (fieldVisibilityState === 'all') fieldsToShow.push(field);
                        else if (isTargetField(field)) fieldsToShow.push(field);
                        else fieldsToHide.push(field);
                    } catch (e) { console.warn('Error processing field:', field, e); }
                });
                fieldsToHide.forEach(field => { try { field.classList.add('hidden-form-field'); } catch (e) { } });
                fieldsToShow.forEach(field => { try { field.classList.remove('hidden-form-field'); } catch (e) { } });
            });
            updateToggleButtonState();
            setTimeout(() => { isApplyingFieldVisibility = false; }, 50);
        });
    }

    const DOMCache = {
        _staticCache: new Map(),
        _volatileCache: new Map(),
        get(selector, isStatic = false, maxAge = null) {
            const cache = isStatic ? this._staticCache : this._volatileCache;
            const defaultMaxAge = isStatic ? config.timing.cacheMaxAge : 1000;
            const actualMaxAge = maxAge || defaultMaxAge;
            const now = Date.now();
            const cached = cache.get(selector);
            if (cached && (now - cached.timestamp) < actualMaxAge) return cached.elements;
            const elements = document.querySelectorAll(selector);
            cache.set(selector, { elements, timestamp: now });
            this._cleanup(cache, actualMaxAge);
            return elements;
        },
        clear() { this._staticCache.clear(); this._volatileCache.clear(); },
        _cleanup(cache, maxAge) {
            if (cache.size > 50) {
                const now = Date.now();
                for (const [key, value] of cache.entries()) {
                    if ((now - value.timestamp) > maxAge * 2) cache.delete(key);
                }
            }
        }
    };

    function injectCSS() {
        if (document.getElementById('rumi-styles')) return;
        const style = document.createElement('style');
        style.id = 'rumi-styles';
        style.textContent = `
            .rumi-icon svg { width: 16px !important; height: 16px !important; display: block !important; }
            .duplicate-icon svg { width: 16px !important; height: 16px !important; display: block !important; }
            .sc-ymabb7-1.fTDEYw { display: inline-flex !important; align-items: center !important; }
            .rumi-text-input { position: fixed; width: 30px; height: 20px; font-size: 12px; border: 1px solid #ccc; border-radius: 3px; padding: 2px; z-index: 1000; background: white; }
            .hidden-form-field { display: none !important; }
            .form-toggle-icon { width: 26px; height: 26px; }
            .hidden-view-item { display: none !important; visibility: hidden !important; opacity: 0 !important; height: 0 !important; overflow: hidden !important; margin: 0 !important; padding: 0 !important; }
            .views-toggle-btn, #views-toggle-button, #views-toggle-wrapper { pointer-events: auto !important; visibility: visible !important; opacity: 1 !important; display: inline-block !important; position: relative !important; z-index: 100 !important; }
            #views-header-left-container { pointer-events: auto !important; visibility: visible !important; display: flex !important; }
            .custom-nav-section { display: flex !important; justify-content: center !important; align-items: center !important; width: 100% !important; }
            .nav-list-item { display: flex !important; justify-content: center !important; align-items: center !important; width: 100% !important; }
            .form-toggle-icon { display: flex !important; justify-content: center !important; align-items: center !important; width: 100% !important; text-align: center !important; }
            .nav-separator { height: 2px; background-color: rgba(47, 57, 65, 0.24); margin: 12px 16px; width: calc(100% - 32px); border-radius: 1px; }
            .rumi-enhancement-overlay { position: fixed !important; top: 0 !important; left: 0 !important; width: 100% !important; height: 100% !important; background: rgba(0,0,0,0.5) !important; z-index: 2147483647 !important; display: flex !important; align-items: center !important; justify-content: center !important; }
            .rumi-enhancement-overlay.rumi-hidden { display: none !important; }
            .rumi-enhancement-panel { background: #F5F5F5 !important; color: #333333 !important; padding: 0 !important; border-radius: 2px !important; box-shadow: 0 1px 3px rgba(0,0,0,0.1) !important; max-width: 900px !important; max-height: 90vh !important; overflow-y: auto !important; width: 95% !important; font-family: Arial, Helvetica, sans-serif !important; border: 1px solid #E0E0E0 !important; }
            .rumi-enhancement-panel h2 { color: #333333 !important; font-size: 14px !important; margin: 0 !important; font-weight: bold !important; text-shadow: none !important; }
            .rumi-enhancement-panel h3 { color: #333333 !important; font-size: 14px !important; margin: 0 0 12px 0 !important; font-weight: bold !important; text-shadow: none !important; }
            .rumi-enhancement-panel h4 { color: #666666 !important; font-size: 13px !important; margin: 0 0 8px 0 !important; font-weight: bold !important; }
            .rumi-enhancement-button { padding: 6px 12px !important; border: 1px solid #CCCCCC !important; border-radius: 2px !important; background: white !important; color: #333333 !important; cursor: pointer !important; margin-right: 8px !important; margin-bottom: 4px !important; font-size: 13px !important; font-family: Arial, Helvetica, sans-serif !important; transition: none !important; box-shadow: none !important; }
            .rumi-enhancement-button-primary { background: #0066CC !important; color: white !important; border-color: #0066CC !important; box-shadow: none !important; }
            .rumi-enhancement-button-danger { background: #DC3545 !important; color: white !important; border-color: #DC3545 !important; box-shadow: none !important; }
            .rumi-enhancement-button:hover { background: #F0F0F0 !important; transform: none !important; box-shadow: none !important; }
            .rumi-enhancement-button-primary:hover { background: #0052A3 !important; }
            .rumi-enhancement-button-danger:hover { background: #C82333 !important; }
            .rumi-enhancement-status-active { color: #28A745 !important; font-weight: bold !important; text-shadow: none !important; font-size: 13px !important; }
            .rumi-enhancement-status-inactive { color: #DC3545 !important; font-weight: bold !important; text-shadow: none !important; font-size: 13px !important; }
            .rumi-enhancement-section { margin-bottom: 16px !important; border-bottom: none !important; padding: 16px !important; background: white !important; border-radius: 2px !important; border: 1px solid #E0E0E0 !important; box-shadow: 0 1px 3px rgba(0,0,0,0.1) !important; }
            .rumi-enhancement-section:last-child { margin-bottom: 0 !important; }
            .rumi-processed-ticket-item { margin-bottom: 8px !important; padding: 8px 12px !important; background: #FAFAFA !important; border-left: 3px solid #0066CC !important; font-size: 13px !important; border-radius: 0 !important; box-shadow: none !important; border: 1px solid #E0E0E0 !important; border-left: 3px solid #0066CC !important; }
            .rumi-enhancement-panel input[type="text"], .rumi-enhancement-panel input[type="range"] { background: white !important; border: 1px solid #CCCCCC !important; color: #333333 !important; border-radius: 2px !important; padding: 6px 8px !important; font-family: Arial, Helvetica, sans-serif !important; font-size: 13px !important; }
            .rumi-enhancement-panel input[type="checkbox"] { accent-color: #0066CC !important; transform: none !important; }
            .rumi-enhancement-panel label { color: #666666 !important; font-size: 13px !important; }
            .rumi-enhancement-panel details { border: 1px solid #E0E0E0 !important; border-radius: 2px !important; padding: 12px !important; background: white !important; }
            .rumi-enhancement-panel summary { color: #333333 !important; font-weight: bold !important; cursor: pointer !important; padding: 8px !important; border-radius: 0 !important; transition: none !important; font-size: 13px !important; }
            .rumi-enhancement-panel summary:hover { background: #F0F0F0 !important; }
            .rumi-view-grid { display: block !important; max-height: 400px !important; overflow-y: auto !important; border: 1px solid #E0E0E0 !important; border-radius: 2px !important; padding: 0 !important; background: white !important; }
            .rumi-view-group { margin-bottom: 0 !important; }
            .rumi-view-group-header { color: #666666 !important; font-size: 11px !important; font-weight: bold !important; margin: 0 !important; padding: 8px 12px !important; background: #F0F0F0 !important; border-radius: 0 !important; border-left: none !important; text-shadow: none !important; text-transform: uppercase !important; letter-spacing: 0.5px !important; border-bottom: 1px solid #E0E0E0 !important; }
            .rumi-view-item { display: flex !important; align-items: center !important; padding: 8px 12px !important; border: none !important; border-radius: 0 !important; background: white !important; cursor: pointer !important; transition: none !important; font-size: 13px !important; margin-bottom: 0 !important; border-bottom: 1px solid #F0F0F0 !important; }
            .rumi-view-item:nth-child(even) { background: #FAFAFA !important; }
            .rumi-view-item:hover { border-color: transparent !important; background: #E8F4FD !important; box-shadow: none !important; transform: none !important; }
            .rumi-view-item.selected { border-color: transparent !important; background: #D1ECF1 !important; box-shadow: none !important; }
            .rumi-view-checkbox { margin-right: 12px !important; accent-color: #0066CC !important; transform: none !important; }
            .rumi-tabs { border: 1px solid #E0E0E0 !important; border-radius: 4px !important; background: white !important; }
            .rumi-tab-headers { display: flex !important; border-bottom: 1px solid #E0E0E0 !important; background: #F8F9FA !important; border-radius: 4px 4px 0 0 !important; }
            .rumi-tab-header { flex: 1 !important; padding: 10px 16px !important; border: none !important; background: transparent !important; cursor: pointer !important; font-size: 13px !important; font-weight: 500 !important; color: #666 !important; border-bottom: 2px solid transparent !important; transition: all 0.2s ease !important; }
            .rumi-tab-header:hover { background: #E9ECEF !important; color: #333 !important; }
            .rumi-tab-header.active { background: white !important; color: #0066CC !important; border-bottom-color: #0066CC !important; margin-bottom: -1px !important; }
            .rumi-tab-content { position: relative !important; }
            .rumi-tab-panel { display: none !important; padding: 16px !important; }
            .rumi-tab-panel.active { display: block !important; }
            .rumi-result-card:hover { transform: translateY(-2px) !important; box-shadow: 0 4px 12px rgba(0,0,0,0.15) !important; border-color: #0066CC !important; }
            .rumi-result-card.selected { border-color: #0066CC !important; box-shadow: 0 2px 8px rgba(0,102,204,0.2) !important; }
            .rumi-view-info { flex: 1 !important; display: flex !important; justify-content: space-between !important; align-items: center !important; }
            .rumi-view-title { font-weight: normal !important; color: #333333 !important; margin-bottom: 0 !important; font-size: 13px !important; }
            .rumi-view-selection-header { display: flex !important; justify-content: space-between !important; align-items: center !important; margin-bottom: 12px !important; }
            .rumi-view-selection-actions { display: flex !important; gap: 8px !important; }
            .rumi-enhancement-top-bar { background: white !important; border-bottom: 1px solid #E0E0E0 !important; padding: 12px 16px !important; display: flex !important; justify-content: space-between !important; align-items: center !important; height: 40px !important; box-sizing: border-box !important; }
            .rumi-main-tabs { display: flex !important; background: #f8f9fa !important; border-bottom: 1px solid #E0E0E0 !important; margin: 0 !important; padding: 0 !important; }
            .rumi-main-tab { flex: 1 !important; background: transparent !important; border: none !important; padding: 12px 16px !important; cursor: pointer !important; font-size: 13px !important; font-weight: 500 !important; color: #666666 !important; border-bottom: 3px solid transparent !important; transition: all 0.2s ease !important; }
            .rumi-main-tab:hover { background: #e9ecef !important; color: #333333 !important; }
            .rumi-main-tab.active { color: #0066CC !important; background: white !important; border-bottom-color: #0066CC !important; }
            .rumi-main-tab-content { position: relative !important; }
            .rumi-main-tab-panel { display: none !important; }
            .rumi-main-tab-panel.active { display: block !important; }
            .rumi-metrics-row { display: flex !important; gap: 16px !important; margin-bottom: 16px !important; }
            .rumi-metric-box { flex: 1 !important; background: white !important; border: 1px solid #E0E0E0 !important; border-radius: 2px !important; padding: 12px !important; text-align: center !important; box-shadow: 0 1px 3px rgba(0,0,0,0.1) !important; }
            .rumi-metric-value { font-size: 18px !important; font-weight: bold !important; color: #333333 !important; display: block !important; margin-bottom: 4px !important; }
            .rumi-metric-label { font-size: 11px !important; color: #666666 !important; text-transform: uppercase !important; letter-spacing: 0.5px !important; }
            .rumi-control-panel { display: flex !important; align-items: center !important; gap: 16px !important; margin-bottom: 16px !important; }
            .rumi-status-indicator { display: flex !important; align-items: center !important; gap: 6px !important; }
            .rumi-status-dot { width: 8px !important; height: 8px !important; border-radius: 50% !important; display: inline-block !important; }
            .rumi-status-dot.active { background: #28A745 !important; }
            .rumi-status-dot.inactive { background: #DC3545 !important; }
            .rumi-view-actions { opacity: 1 !important; }
            .rumi-csv-download-btn { min-width: 28px !important; height: 24px !important; padding: 4px !important; margin-right: 0 !important; margin-bottom: 0 !important; font-size: 14px !important; line-height: 1 !important; display: flex !important; align-items: center !important; justify-content: center !important; }
            .rumi-csv-download-btn svg { width: 16px !important; height: 16px !important; display: block !important; }
            .rumi-manual-export-simple { display: flex; flex-direction: column; gap: 6px; }
            .rumi-export-simple-item { display: flex; align-items: center; justify-content: space-between; padding: 6px 12px; background: #F8F9FA; border: 1px solid #E0E0E0; border-radius: 3px; }
            .rumi-export-view-name { font-size: 12px; color: #495057; flex: 1; }
            .rumi-manual-export-btn { min-width: 28px !important; height: 24px !important; padding: 4px !important; margin-left: 8px !important; font-size: 14px !important; line-height: 1 !important; display: flex !important; align-items: center !important; justify-content: center !important; }
            .rumi-manual-export-btn svg { width: 16px !important; height: 16px !important; display: block !important; }
            .rumi-log-entry { display: flex !important; align-items: flex-start !important; gap: 8px !important; padding: 4px 0 !important; border-bottom: 1px solid #F0F0F0 !important; font-size: 11px !important; line-height: 1.3 !important; }
            .rumi-log-entry:last-child { border-bottom: none !important; }
            .rumi-log-time { color: #666 !important; min-width: 60px !important; font-size: 10px !important; }
            .rumi-log-level { min-width: 40px !important; font-weight: bold !important; font-size: 10px !important; text-align: center !important; padding: 1px 4px !important; border-radius: 2px !important; }
            .rumi-log-error .rumi-log-level { background: #ffebee !important; color: #c62828 !important; }
            .rumi-log-warn .rumi-log-level { background: #fff8e1 !important; color: #f57f17 !important; }
            .rumi-log-info .rumi-log-level { background: #e3f2fd !important; color: #1565c0 !important; }
            .rumi-log-debug .rumi-log-level { background: #f3e5f5 !important; color: #7b1fa2 !important; }
            .rumi-log-ticket { background: #e8f5e8 !important; color: #2e7d32 !important; padding: 1px 4px !important; border-radius: 2px !important; font-size: 10px !important; font-weight: bold !important; min-width: 70px !important; text-align: center !important; }
            .rumi-log-message { flex: 1 !important; color: #333 !important; word-wrap: break-word !important; }
            #rumi-safety-buttons-container { display: flex !important; justify-content: flex-end !important; margin-left: auto !important; gap: 4px !important; padding: 4px 8px !important; flex-wrap: wrap !important; }
            .rumi-safety-btn { display: inline-flex !important; align-items: center !important; justify-content: center !important; cursor: pointer !important; user-select: none !important; height: 26px !important; padding: 0 9px !important; font-size: 11px !important; font-weight: 600 !important; line-height: 1 !important; border-radius: 4px !important; border: 1px solid rgba(0, 0, 0, 0.18) !important; background: #f5f5f5 !important; color: #3a3a3a !important; opacity: 0.9; transition: background 0.15s, color 0.15s, opacity 0.15s !important; white-space: nowrap !important; }
            .rumi-safety-btn:hover { opacity: 1 !important; background: #e8f0fe !important; border-color: #4a90d9 !important; color: #1a56a8 !important; }
            .rumi-safety-btn.rumi-safety-active { background: #fff3cd !important; border-color: #e6a817 !important; color: #8a5e00 !important; opacity: 1 !important; font-weight: 700 !important; }
        `;
        document.head.appendChild(style);
    }

    const eyeOpenSVG = `<svg viewBox="0 0 24 24"><path d="M12 4.5C7 4.5 2.73 7.61 1 12c1.73 4.39 6 7.5 11 7.5s9.27-3.11 11-7.5c-1.73-4.39-6-7.5-11-7.5zM12 17c-2.76 0-5-2.24-5-5s2.24-5 5-5 5 2.24 5 5-2.24 5-5 5zm0-8c-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3-1.34-3-3-3z"/></svg>`;
    const eyeClosedSVG = `<svg viewBox="0 0 24 24"><path d="M12 7c2.76 0 5 2.24 5 5 0 .65-.13 1.26-.36 1.83l2.92 2.92c1.51-1.26 2.7-2.89 3.43-4.75-1.73-4.39-6-7.5-11-7.5-1.4 0-2.74.25-3.98.7l2.16 2.16C10.74 7.13 11.35 7 12 7zM2 4.27l2.28 2.28.46.46C3.08 8.3 1.78 10.02 1 12c1.73 4.39 6 7.5 11 7.5 1.55 0 3.03-.3 4.38-.84l.42.42L19.73 22 21 20.73 3.27 3 2 4.27zM7.53 9.8l1.55 1.55c-.05.21-.08.43-.08.65 0 1.66 1.34 3 3 3 .22 0 .44-.03.65-.08l1.55 1.55c-.67.33-1.41.53-2.2.53-2.76 0-5-2.24-5-5 0-.79.2-1.53.53-2.2zm4.31-.78l3.15 3.15.02-.16c0-1.66-1.34-3-3-3l-.17.01z"/></svg>`;
    const uberLogoSVG = `<svg viewBox="0 0 512 512" xmlns="http://www.w3.org/2000/svg"><circle cx="256" cy="256" r="256" fill="currentColor"/><path d="M256 176c44.112 0 80 35.888 80 80s-35.888 80-80 80-80-35.888-80-80 35.888-80 80-80zm0-48c-70.692 0-128 57.308-128 128s57.308 128 128 128 128-57.308 128-128-57.308-128-128-128z" fill="white"/><rect x="176" y="272" width="160" height="16" fill="white"/></svg>`;
    const duplicateIconSVG = `<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z" fill="currentColor"/></svg>`;
    const downloadIconSVG = `<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z" fill="currentColor"/></svg>`;

    function debounce(func, delay, key) {
        if (debounceTimers.has(key)) clearTimeout(debounceTimers.get(key));
        const timerId = setTimeout(() => { debounceTimers.delete(key); func(); }, delay);
        debounceTimers.set(key, timerId);
    }

    const RUMILogger = {
        log(level, category, message, ticketId = null, data = null) {
            if (level > rumiEnhancement.currentLogLevel) return;
            const timestamp = new Date();
            const levelNames = ['ERROR', 'WARN', 'INFO', 'DEBUG'];
            const levelName = levelNames[level];
            const logEntry = { id: Date.now() + Math.random(), timestamp, level: levelName, category, message, ticketId, data, timeString: timestamp.toLocaleTimeString() };
            rumiEnhancement.automationLogs.unshift(logEntry);
            if (rumiEnhancement.automationLogs.length > 500) rumiEnhancement.automationLogs = rumiEnhancement.automationLogs.slice(0, 500);
            this.updateLogDisplay();
            if (level <= 1) {
                const styles = { ERROR: 'color: #ff4444; font-weight: bold;', WARN: 'color: #ffaa00; font-weight: bold;' };
                console.log(`%c[RUMI-${levelName}] ${message}${ticketId ? ` (Ticket: ${ticketId})` : ''}`, styles[levelName], data || '');
            }
        },
        updateLogDisplay() {
            const logContainer = document.getElementById('rumi-log-container');
            if (!logContainer) return;
            const wasAtBottom = this.isScrolledToBottom(logContainer);
            const filter = document.getElementById('rumi-log-filter')?.value || 'all';
            let displayLogs = rumiEnhancement.automationLogs.slice(0, 100);
            if (filter !== 'all') {
                const levelHierarchy = { 'debug': 3, 'info': 2, 'warn': 1, 'error': 0 };
                const minLevel = levelHierarchy[filter];
                displayLogs = displayLogs.filter(log => levelHierarchy[log.level.toLowerCase()] <= minLevel);
            }
            logContainer.innerHTML = '';
            if (displayLogs.length === 0) { logContainer.innerHTML = '<div style="text-align: center; color: #666; padding: 20px;">No logs yet</div>'; return; }
            displayLogs.forEach(log => {
                const logElement = document.createElement('div');
                logElement.className = `rumi-log-entry rumi-log-${log.level.toLowerCase()}`;
                let ticketInfo = log.ticketId ? `<span class="rumi-log-ticket">Ticket #${log.ticketId}</span>` : '';
                logElement.innerHTML = `<div class="rumi-log-time">${log.timeString}</div><div class="rumi-log-level">${log.level}</div>${ticketInfo}<div class="rumi-log-message">${log.message}</div>`;
                logContainer.appendChild(logElement);
            });
            if (wasAtBottom) this.scrollToBottom(logContainer);
        },
        isScrolledToBottom(container) { return container.scrollTop + container.clientHeight >= container.scrollHeight - 5; },
        scrollToBottom(container) { container.scrollTop = container.scrollHeight; },
        setupLogScrollDetection() {
            const logContainer = document.getElementById('rumi-log-container');
            if (!logContainer) return;
            logContainer.removeEventListener('scroll', this.handleLogScroll);
            this.handleLogScroll = () => { logContainer.setAttribute('data-user-scrolled', !this.isScrolledToBottom(logContainer)); };
            logContainer.addEventListener('scroll', this.handleLogScroll);
        },
        error(category, message, ticketId = null, data = null) { this.log(0, category, message, ticketId, data); },
        warn(category, message, ticketId = null, data = null) { this.log(1, category, message, ticketId, data); },
        info(category, message, ticketId = null, data = null) { this.log(2, category, message, ticketId, data); },
        debug(category, message, ticketId = null, data = null) { this.log(3, category, message, ticketId, data); },
        ticketProcessed(action, ticketId, details) { this.info('PROCESS', `${action} - ${details}`, ticketId); },
        ticketSkipped(reason, ticketId) { this.debug('PROCESS', `Skipped: ${reason}`, ticketId); },
        monitoringStatus(message) { this.info('MONITOR', `Monitoring: ${message}`); },
        apiActivity(message, count = null) { this.debug('API', count ? `${message} (${count} calls)` : message); }
    };

    const RUMIAPIManager = {
        async makeRequest(endpoint, options = {}) {
            const startTime = Date.now();
            if (rumiEnhancement.consecutiveErrors >= rumiEnhancement.config.CIRCUIT_BREAKER_THRESHOLD) {
                RUMILogger.warn('API', `Circuit breaker activated`);
                throw new Error('Circuit breaker activated - too many consecutive errors');
            }
            const defaultOptions = { method: 'GET', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' }, credentials: 'same-origin' };
            const finalOptions = { ...defaultOptions, ...options };
            console.log('API', `Making ${finalOptions.method} request to ${endpoint}`);
            try {
                const response = await fetch(endpoint, finalOptions);
                const responseTime = Date.now() - startTime;
                if (response.status === 429) throw new Error(`HTTP 429: Rate limited`);
                if (!response.ok) throw new Error(`HTTP ${response.status}: ${response.statusText}`);
                const data = await response.json();
                rumiEnhancement.consecutiveErrors = 0;
                rumiEnhancement.apiCallCount++;
                console.log('API', `Request successful (${responseTime}ms)`, { endpoint, status: response.status });
                return data;
            } catch (error) {
                if (!error.message.includes('429') && !error.message.includes('400')) rumiEnhancement.consecutiveErrors++;
                RUMILogger.error('API', `Request failed: ${error.message}`, { endpoint, consecutiveErrors: rumiEnhancement.consecutiveErrors });
                throw error;
            }
        },
        async makeRequestWithRetry(endpoint, options = {}, maxRetries = rumiEnhancement.config.MAX_RETRIES) {
            try { return await this.makeRequest(endpoint, options); }
            catch (error) {
                if (!error.message.includes('429') && maxRetries > 0) {
                    RUMILogger.warn('API', `Request failed, retrying once: ${error.message}`);
                    await new Promise(resolve => setTimeout(resolve, 2000));
                    return await this.makeRequest(endpoint, options);
                }
                throw error;
            }
        },
        checkRateLimit() {
            const now = Date.now();
            if (now - rumiEnhancement.lastApiReset > 60000) {
                rumiEnhancement.lastApiReset = now;
                if (rumiEnhancement.consecutiveErrors > 0) { RUMILogger.info('API', 'Rate limit window reset'); rumiEnhancement.consecutiveErrors = 0; }
            }
            return true;
        },
        async waitForRateLimit() {
            if (!this.checkRateLimit()) {
                const waitTime = 60000 - (Date.now() - rumiEnhancement.lastApiReset);
                RUMILogger.warn('API', `Rate limit approached, waiting ${Math.ceil(waitTime / 1000)}s`);
                await new Promise(resolve => setTimeout(resolve, Math.max(waitTime, 5000)));
            }
        },
        async validateConnectivity() {
            try { await this.makeRequest('/api/v2/users/me.json'); RUMILogger.info('VALIDATION', 'API connectivity validated'); return true; }
            catch (error) { RUMILogger.error('VALIDATION', 'API connectivity failed', error); return false; }
        }
    };

    const RUMIZendeskAPI = {
        async getViews() {
            try { const data = await RUMIAPIManager.makeRequestWithRetry('/api/v2/views.json'); RUMILogger.info('ZENDESK', `Retrieved ${data.views.length} views`); return data.views; }
            catch (error) { RUMILogger.error('ZENDESK', 'Failed to retrieve views', error); throw error; }
        },
        async getViewTickets(viewId, options = {}) {
            try {
                const { per_page = 100, page = 1, sort_by = 'created_at', sort_order = 'desc', include = 'via_id' } = options;
                const endpoint = `/api/v2/views/${viewId}/execute.json?per_page=${per_page}&page=${page}&sort_by=${sort_by}&sort_order=${sort_order}&group_by=+&include=${include}`;
                const data = await RUMIAPIManager.makeRequestWithRetry(endpoint);
                console.log('ZENDESK', `Retrieved ${data.rows?.length || 0} tickets from view ${viewId}`);
                return data.rows || [];
            } catch (error) { RUMILogger.error('ZENDESK', `Failed to retrieve tickets for view ${viewId}`, error); throw error; }
        },
        async exportViewAsCSV(viewId, viewName = null) {
            try {
                const data = await RUMIAPIManager.makeRequestWithRetry(`/api/v2/views/${viewId}/export`);
                return { status: data.export?.status || 'unknown', message: data.export?.message || null, viewId, viewName };
            } catch (error) { RUMILogger.error('ZENDESK', `Failed to export CSV for view ${viewId}`, error); throw error; }
        },
        async getViewTicketsForDirectCSV(viewId, viewName = null) {
            try {
                RUMILogger.info('ZENDESK', `Fetching all tickets for direct CSV export: view ${viewId} (${viewName})`);
                const firstPageData = await RUMIAPIManager.makeRequestWithRetry(`/api/v2/views/${viewId}/execute.json?per_page=100&page=1&sort_by=created_at&sort_order=desc&group_by=+&include=via_id`);
                let allTickets = firstPageData.rows || [];
                const totalCount = firstPageData.count || 0;
                const totalPages = Math.ceil(totalCount / 100);
                if (totalPages > 1) {
                    const pagePromises = [];
                    for (let page = 2; page <= Math.min(totalPages, 10); page++) pagePromises.push(RUMIAPIManager.makeRequestWithRetry(`/api/v2/views/${viewId}/execute.json?per_page=100&page=${page}&sort_by=created_at&sort_order=desc&group_by=+&include=via_id`));
                    const additionalPages = await Promise.all(pagePromises);
                    additionalPages.forEach(pageData => { if (pageData.rows) allTickets = allTickets.concat(pageData.rows); });
                }
                return { tickets: allTickets, users: firstPageData.users || [], count: totalCount, viewId, viewName };
            } catch (error) { RUMILogger.error('ZENDESK', `Failed to fetch tickets for direct CSV export: view ${viewId}`, error); throw error; }
        },
        async getTicketComments(ticketId) {
            try {
                const data = await RUMIAPIManager.makeRequestWithRetry(`/api/v2/tickets/${ticketId}/comments.json?sort_order=desc`);
                console.log('ZENDESK', `Retrieved ${data.comments.length} comments for ticket ${ticketId}`);
                return data.comments;
            } catch (error) { RUMILogger.error('ZENDESK', `Failed to retrieve comments for ticket ${ticketId}`, error); throw error; }
        },
        async getUserDetails(userId) {
            try {
                const data = await RUMIAPIManager.makeRequestWithRetry(`/api/v2/users/${userId}.json`);
                console.log('ZENDESK', `Retrieved user details for user ${userId}`);
                return data.user;
            } catch (error) { RUMILogger.error('ZENDESK', `Failed to retrieve user details for user ${userId}`, error); throw error; }
        },
        async updateTicketStatus(ticketId, status = 'pending', viewName = null) {
            const updates = { status };
            if (status === 'pending') { updates.assignee_id = 34980896869267; RUMILogger.info('ZENDESK', `Setting ticket ${ticketId} to pending`); }
            return this.updateTicket(ticketId, updates, viewName);
        },
        async updateTicketWithAssignee(ticketId, status, assigneeId, viewName = null) {
            return this.updateTicket(ticketId, { status, assignee_id: assigneeId }, viewName);
        },
        async updateTicket(ticketId, updates, viewName = null) {
            const isEgyptView = viewName && (viewName.includes('SSOC - Egypt Open') || viewName.includes('SSOC - Egypt Urgent'));
            let ticketUpdates = { ...updates };
            if (isEgyptView && updates.status === 'pending' && !rumiEnhancement.isDryRun) {
                try {
                    const currentTicket = await RUMIAPIManager.makeRequestWithRetry(`/api/v2/tickets/${ticketId}.json`);
                    const currentPriority = currentTicket?.ticket?.priority;
                    if (currentPriority && ['low', 'high', 'urgent'].includes(currentPriority)) ticketUpdates.priority = 'normal';
                } catch (e) { RUMILogger.warn('ZENDESK', `Could not check current priority for ticket ${ticketId}`, e); }
            }
            if (rumiEnhancement.isDryRun) { RUMILogger.info('DRY-RUN', `Would update ticket ${ticketId}`); return { ticket: { id: ticketId, ...ticketUpdates } }; }
            try {
                const csrfToken = this.getCSRFToken();
                if (!csrfToken) throw new Error('CSRF token not found');
                const data = await RUMIAPIManager.makeRequestWithRetry(`/api/v2/tickets/${ticketId}.json`, { method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken, 'X-Requested-With': 'XMLHttpRequest' }, body: JSON.stringify({ ticket: ticketUpdates }) });
                RUMILogger.info('ZENDESK', `Updated ticket ${ticketId}`);
                return data;
            } catch (error) { RUMILogger.error('ZENDESK', `Failed to update ticket ${ticketId}`, error); throw error; }
        },
        getCSRFToken() {
            const methods = [
                () => document.querySelector('meta[name="csrf-token"]')?.getAttribute('content'),
                () => document.querySelector('meta[name="_csrf"]')?.getAttribute('content'),
                () => window.csrfToken,
                () => { const scripts = document.querySelectorAll('script'); for (const script of scripts) { const match = script.textContent.match(/csrf[_-]?token["']?\s*[:=]\s*["']([^"']+)["']/i); if (match) return match[1]; } return null; }
            ];
            for (const method of methods) { try { const token = method(); if (token) return token; } catch (e) { } }
            RUMILogger.warn('ZENDESK', 'CSRF token not found');
            return null;
        }
    };

    const RUMICSVUtils = {
        generateTicketIDsCSV(viewData) {
            const { tickets } = viewData;
            const ticketIds = tickets.map(ticketRow => { const ticket = ticketRow.ticket || ticketRow; return ticket.id; }).filter(id => id);
            return ticketIds.join(',');
        },
        async copyToClipboard(text) {
            try { await navigator.clipboard.writeText(text); return true; }
            catch (error) { RUMILogger.error('CSV', 'Failed to copy to clipboard', error); return false; }
        }
    };

    const minimalFields = ['Tags', 'Priority', 'Reason (Quality/GO/Billing)*', 'Reason (Quality/GO/Billing)', 'SSOC Reason', 'Action Taken - Consumer', 'SSOC incident source', 'City', 'Language'];

    function isSystemField(field) {
        if (!field || !field.querySelector) return false;
        const label = field.querySelector('label');
        if (!label) return false;
        const labelText = label.textContent.trim().toLowerCase();
        if (['assignee', 'ccs', 'cc', 'collaborators', 'followers'].some(sysLabel => labelText.includes(sysLabel))) return true;
        if (labelText === 'requester') return true;
        const testIds = ['ticket-system-field-requester-label', 'ticket-system-field-requester-select', 'assignee-field', 'ticket-fields-collaborators'];
        if (testIds.some(testId => field.querySelector(`[data-test-id*="${testId}"]`) || field.getAttribute('data-test-id') === testId)) return true;
        const fieldTestId = field.getAttribute('data-test-id') || '';
        if (fieldTestId === 'ticket-system-field-requester-label' || fieldTestId === 'ticket-system-field-requester-select') return true;
        return false;
    }

    function isTargetField(field) {
        const label = field.querySelector('label');
        if (!label) return false;
        if (fieldVisibilityState === 'all') return false;
        const labelText = label.textContent.trim();
        return minimalFields.some(targetText => {
            if (labelText === targetText) return true;
            if (labelText.replace(/\*$/, '').trim() === targetText) return true;
            if (targetText.endsWith('*') && labelText === targetText.slice(0, -1).trim()) return true;
            if (labelText.toLowerCase() === targetText.toLowerCase()) return true;
            return false;
        });
    }

    async function getUsernameFromAPI() {
        try {
            const storedUsername = localStorage.getItem('zendesk_agent_username');
            if (storedUsername && storedUsername.trim()) { username = storedUsername.trim(); console.log(`🔐 Agent name loaded from storage: ${username}`); return username; }
            console.log('🔐 Fetching username from API...');
            const response = await fetch('/api/v2/users/me.json');
            if (!response.ok) throw new Error(`API request failed with status ${response.status}`);
            const data = await response.json();
            if (data && data.user && data.user.name) {
                username = data.user.name.trim();
                localStorage.setItem('zendesk_agent_username', username);
                console.log(`🔐 Agent name fetched from API: ${username}`);
                return username;
            } else throw new Error('User name not found in API response');
        } catch (error) {
            console.error('❌ Error fetching username from API:', error);
            username = 'Agent';
            return username;
        }
    }

    async function setDropdownFieldValueInstant(field, valueText) {
        try {
            console.log(`⚡ Setting "${valueText}"`);
            if (!field || !valueText) return false;
            const input = field.querySelector('input[data-test-id="ticket-field-input"]') || field.querySelector('[role="combobox"] input') || field.querySelector('input');
            if (!input) return false;
            const displayValue = field.querySelector('[title]')?.getAttribute('title') || field.querySelector('.StyledEllipsis-sc-1u4umy-0')?.textContent.trim() || field.querySelector('[data-garden-id="typography.ellipsis"]')?.textContent.trim();
            if (displayValue === valueText) { console.log(`✅ "${valueText}" already set`); return true; }
            const success = await tryManualDropdownSet(field, valueText, 0);
            console.log(`${success ? '✅' : '❌'} "${valueText}" ${success ? 'SUCCESS' : 'FAILED'}`);
            return success;
        } catch (e) { console.warn('Dropdown set failed:', e); return false; }
    }

    async function tryManualDropdownSet(field, valueText, retries) {
        try {
            const trigger = field.querySelector('[role="combobox"]') || field.querySelector('input[data-test-id="ticket-field-input"]') || field.querySelector('input');
            if (!trigger) return false;
            if (trigger.dataset.isProcessing === 'true') return false;
            trigger.dataset.isProcessing = 'true';
            try {
                trigger.focus(); trigger.click();
                await new Promise(resolve => setTimeout(resolve, 100));
                const options = document.querySelectorAll('[role="option"], [data-test-id="ticket-field-option"]');
                const targetOption = Array.from(options).find(option => option.textContent.trim() === valueText && option.isConnected);
                if (targetOption) { targetOption.click(); await new Promise(resolve => setTimeout(resolve, 50)); return true; }
                else { trigger.blur(); return false; }
            } finally { trigger.dataset.isProcessing = 'false'; }
        } catch (e) { return false; }
    }

    async function setSSOCReasonToEscalated(container) {
        const fields = container.querySelectorAll('[class*="field"], [data-test-id*="field"], div:has(label)');
        let fieldFound = false;
        for (const field of fields) {
            const label = field.querySelector('label');
            if (label && label.textContent.trim() === 'SSOC Reason') {
                if (fieldFound) continue;
                fieldFound = true;
                const currentValue = field.querySelector('[title]')?.getAttribute('title') || field.querySelector('.StyledEllipsis-sc-1u4umy-0')?.textContent.trim() || field.querySelector('[data-garden-id="typography.ellipsis"]')?.textContent.trim();
                if (currentValue === 'Escalated to Uber') { console.log(`✅ SSOC Reason already set`); return true; }
                try { return await setDropdownFieldValueInstant(field, 'Escalated to Uber'); } catch (error) { console.error('❌ Error setting SSOC Reason:', error); return false; }
            }
        }
        console.log('⚠️ SSOC Reason field not found'); return true;
    }

    async function setActionTakenConsumer(container) {
        const fields = container.querySelectorAll('[class*="field"], [data-test-id*="field"], div:has(label)');
        let fieldFound = false;
        for (const field of fields) {
            const label = field.querySelector('label');
            if (label && label.textContent.trim() === 'Action Taken - Consumer') {
                if (fieldFound) continue;
                fieldFound = true;
                const currentValue = field.querySelector('[title]')?.getAttribute('title') || field.querySelector('.StyledEllipsis-sc-1u4umy-0')?.textContent.trim() || field.querySelector('[data-garden-id="typography.ellipsis"]')?.textContent.trim();
                if (currentValue === 'Resolved - Escalated to Uber') return true;
                try { return await setDropdownFieldValueInstant(field, 'Resolved - Escalated to Uber'); } catch (error) { return false; }
            }
        }
        return true;
    }

    async function setReasonToDuplicate(container) {
        const fields = container.querySelectorAll('[class*="field"], [data-test-id*="field"], div:has(label)');
        const promises = [];
        let fieldFound = false;
        Array.from(fields).forEach(field => {
            const label = field.querySelector('label');
            if (label && (label.textContent.trim() === 'Reason (Quality/GO/Billing)*' || label.textContent.trim() === 'Reason (Quality/GO/Billing)')) {
                if (fieldFound) return;
                fieldFound = true;
                const currentValue = field.querySelector('[title]')?.getAttribute('title') || field.querySelector('.StyledEllipsis-sc-1u4umy-0')?.textContent.trim() || field.querySelector('[data-garden-id="typography.ellipsis"]')?.textContent.trim();
                if (currentValue === 'Operations related - Invalid tickets/calls (Already resolved / duplicates)') return;
                promises.push(setDropdownFieldValueInstant(field, 'Operations related - Invalid tickets/calls (Already resolved / duplicates)'));
            }
        });
        const results = await Promise.allSettled(promises);
        const successCount = results.filter(result => result.status === 'fulfilled' && result.value === true).length;
        return promises.length === 0 || successCount > 0;
    }

    async function setActionTakenConsumerDuplicate(container) { return setActionTakenConsumer(container); }

    async function setSSOCReasonToDuplicate(container) { return setSSOCReasonToEscalated(container); }

    async function setSSOCIncidentSourceWithDebug(field, targetValue) {
        try {
            const trigger = field.querySelector('[role="combobox"]') || field.querySelector('input[data-test-id="ticket-field-input"]') || field.querySelector('input');
            if (!trigger) return false;
            if (trigger.dataset.isProcessing === 'true') return false;
            trigger.dataset.isProcessing = 'true';
            try {
                trigger.focus(); trigger.click();
                await new Promise(resolve => setTimeout(resolve, 200));
                const options = document.querySelectorAll('[role="option"], [data-test-id="ticket-field-option"]');
                const optionTexts = Array.from(options).map(opt => opt.textContent.trim()).filter(text => text);
                console.log('📋 Available options:', optionTexts);
                let targetOption = Array.from(options).find(option => option.textContent.trim() === targetValue && option.isConnected);
                if (!targetOption && targetValue === 'Customer Email') {
                    for (const variation of ['Customer Email', 'Email', 'Customer email', 'customer email', 'Email - Customer']) {
                        targetOption = Array.from(options).find(option => option.textContent.trim() === variation && option.isConnected);
                        if (targetOption) break;
                    }
                    if (!targetOption) targetOption = Array.from(options).find(option => option.textContent.trim().toLowerCase().includes('email') && option.isConnected);
                }
                if (targetOption) {
                    targetOption.click();
                    await new Promise(resolve => setTimeout(resolve, 100));
                    const displayValue = field.querySelector('[title]')?.getAttribute('title') || field.querySelector('.StyledEllipsis-sc-1u4umy-0')?.textContent.trim() || field.querySelector('[data-garden-id="typography.ellipsis"]')?.textContent.trim();
                    return displayValue && (displayValue === targetValue || displayValue === targetOption.textContent.trim());
                } else { trigger.blur(); return false; }
            } finally { trigger.dataset.isProcessing = 'false'; }
        } catch (e) { console.error('❌ Error in setSSOCIncidentSourceWithDebug:', e); return false; }
    }

    function hasExcludeDetectionTag() {
        const tagElements = document.querySelectorAll('.garden-tag-item, [data-test-id="ticket-system-field-tags-item-selected"] .garden-tag-item');
        return Array.from(tagElements).map(el => el.textContent.trim().toLowerCase()).includes('exclude_detection');
    }

    function hasVoiceCareTag() {
        const tagElements = document.querySelectorAll('.garden-tag-item, [data-test-id="ticket-system-field-tags-item-selected"] .garden-tag-item');
        return Array.from(tagElements).map(el => el.textContent.trim().toLowerCase()).includes('ssoc_voice_created_ticket');
    }

    function hasApolloTag() {
        const tagElements = document.querySelectorAll('.garden-tag-item, [data-test-id="ticket-system-field-tags-item-selected"] .garden-tag-item');
        return Array.from(tagElements).map(el => el.textContent.trim().toLowerCase()).includes('apollo_created_ticket');
    }
    function hasReportSafetyIssueInComments() {
        const commentElements = document.querySelectorAll('[data-test-id="omni-log-message-content"] .zd-comment');
        return Array.from(commentElements).some(el =>
            el.textContent.trim() === 'Selected issue: Report safety issue(s)'
        );
    }
    function hasVoiceCareTicketInComments() {
        const commentElements = document.querySelectorAll('[data-test-id="omni-log-omni-to-ag-comment"]');
        return Array.from(commentElements).some(el =>
            /\(voice care ticket\s*#\d+\)/i.test(el.textContent)
        );
        }
    async function fetchTicketComments(ticketId) {
        try {
            const response = await fetch(`https://gocareem.zendesk.com/api/v2/tickets/${ticketId}/comments.json`, { method: 'GET', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' }, credentials: 'include' });
            if (!response.ok) { console.error(`❌ Failed to fetch comments: ${response.status}`); return null; }
            const data = await response.json();
            return data.comments || [];
        } catch (error) { console.error('❌ Error fetching ticket comments:', error); return null; }
    }

    // ── Conversations API: extract customer words for normal tickets ───────────
    async function fetchCustomerWordsFromConversations(ticketId) {
        try {
            const resp = await fetch(
                `https://gocareem.zendesk.com/api/lotus/tickets/${ticketId}/conversations.json`,
                { method: 'GET', credentials: 'include', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' } }
            );
            if (!resp.ok) { console.warn(`⚠️ CONVERSATIONS: HTTP ${resp.status} for ticket ${ticketId}`); return ''; }
            const data = await resp.json();
            const conversations = data.conversations || [];
            if (conversations.length === 0) return '';

            // Step 1: customer = author_id of the very first comment
            const customerId = conversations[0].author_id;
            console.log(`👤 CONVERSATIONS: Customer author_id = ${customerId}`);

            // Step 2: collect all plain_body values written by the customer
            const STRIP_PREFIXES = ['Selected issue category', 'Selected issue', 'Customer selected reason', 'Customer selected sub-reason', 'Customer selected second sub-reason'];
            const customerBodies = conversations
                .filter(c => c.author_id === customerId && c.plain_body && c.plain_body.trim())
                .map(c => {
                    let body = c.plain_body;
                    // Step 3: repeatedly strip any leading "Selected issue …\n\n" blocks
                    let changed = true;
                    while (changed) {
                        changed = false;
                        for (const keyword of STRIP_PREFIXES) {
                            if (body.trimStart().startsWith(keyword)) {
                                const nnIdx = body.indexOf('\n\n');
                                if (nnIdx !== -1) { body = body.slice(nnIdx + 2); changed = true; }
                                else { body = ''; changed = false; }
                                break;
                            }
                        }
                    }
                    return body.trim();
                })
                .filter(Boolean);

            if (customerBodies.length === 0) return '';
            const result = customerBodies.join('\n');
            console.log(`📝 CONVERSATIONS: Extracted customer words: "${result.slice(0, 100)}..."`);
            return result;
        } catch (err) { console.error('❌ CONVERSATIONS: Failed to fetch conversations:', err); return ''; }
    }
    // ─────────────────────────────────────────────────────────────────────────

    async function hasVoiceCareInComments(ticketId) {
        try {
            const comments = await fetchTicketComments(ticketId);
            if (!comments) return false;
            for (const comment of comments) { if (comment.body && comment.body.includes('(Voice care ticket')) return true; }
            return false;
        } catch (error) { console.error('❌ Error checking comments for voice care:', error); return false; }
    }

    // ── Voice Care Ticket: Advanced Description Extractor ────────────────────
    const KNOWN_FIELDS = [
        'Customer Name', 'Customer Phone Number', 'Trip ID', 'Trip Date',
        'Detailed Description', 'Keywords or Safety Triggers Identified',
        'Screenshots', 'Agent Summary', "Customer's Preferred", 'Staff'
    ];

    const STOP_WORDS = /^(Detailed|Screenshots|Agent|Customer|Staff|Trip|Keywords|Payment|Event)/i;

    function detectAndStripPrefix(text) {
        const lines = text.split('\n');
        let prefix = '';
        for (const line of lines) {
            for (const field of KNOWN_FIELDS) {
                const idx = line.indexOf(field);
                if (idx > 0) { prefix = line.slice(0, idx); break; }
            }
            if (prefix) break;
        }
        if (!prefix.trim()) {
            return text.replace(/^[^\S\r\n]*🔹\s*/gm, '');
        }
        const esc = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        return text
            .replace(new RegExp('^' + esc, 'gm'), '')
            .replace(/^[^\S\r\n]*🔹\s*/gm, '');
    }

    function extractValue(lines, labelRe) {
        let lineIdx = -1, labelEndPos = 0;
        for (let i = 0; i < lines.length; i++) {
            const m = lines[i].match(labelRe);
            if (m) { lineIdx = i; labelEndPos = m[0].length; break; }
        }
        if (lineIdx === -1) return null;
        const firstContent = lines[lineIdx].slice(labelEndPos).trim();
        const collected = firstContent ? [firstContent] : [];
        for (let i = lineIdx + 1; i < lines.length; i++) {
            const t = lines[i].trim();
            if (!t || STOP_WORDS.test(t)) break;
            collected.push(t);
        }
        return collected.join(' ').trim() || null;
    }

    function normalizeDesc(s) {
        return s.toLowerCase().replace(/\s+/g, ' ').replace(/[^a-z0-9 ]/g, '').trim();
    }

    function extractDescription(rawText) {
        if (!rawText) return '';
        const cleaned = detectAndStripPrefix(rawText);
        const lines = cleaned.split('\n');
        const parts = [];

        // ── Detailed Description ──────────────────────────────────────────
        const ddLabelRe = /^[^\S\r\n]*Detailed Description\s*(\([^)]*\))?\s*:/i;
        let mainDesc = '';
        let ddLineIdx = -1, ddLabelEndPos = 0, ddParenRaw = '';

        for (let i = 0; i < lines.length; i++) {
            const m = lines[i].match(ddLabelRe);
            if (m) { ddLineIdx = i; ddLabelEndPos = m[0].length; ddParenRaw = m[1] || ''; break; }
        }

        if (ddLineIdx !== -1) {
            const parenContent = ddParenRaw.slice(1, -1).trim();
            const isLabel = /what was reported/i.test(parenContent);
            const firstContent = lines[ddLineIdx].slice(ddLabelEndPos).trim();
            const collected = firstContent ? [firstContent] : [];
            for (let i = ddLineIdx + 1; i < lines.length; i++) {
                const t = lines[i].trim();
                if (!t || STOP_WORDS.test(t)) break;
                collected.push(t);
            }
            const afterColon = collected.join(' ').trim();

            if (afterColon && isLabel) mainDesc = afterColon;
            else if (afterColon) mainDesc = afterColon;
            else if (parenContent && !isLabel) mainDesc = parenContent.replace(/\r?\n\s*/g, ' ').trim();
        }

        if (mainDesc) parts.push(mainDesc);

        // ── Keywords or Safety Triggers Identified ────────────────────────
        const kwValue = extractValue(lines, /^[^\S\r\n]*Keywords or Safety Triggers Identified\s*:/i);
        if (kwValue) {
            const isSummary = kwValue.length > 20 && kwValue.split(' ').length > 5;
            if (isSummary && normalizeDesc(kwValue) !== normalizeDesc(mainDesc)) {
                parts.push(kwValue);
            }
        }

        // ── Agent Summary & Comments ──────────────────────────────────────
        const agValue = extractValue(lines, /^[^\S\r\n]*Agent Summary\s*(?:&|and)\s*Comments\s*:/i);
        if (agValue && !parts.some(p => normalizeDesc(p) === normalizeDesc(agValue))) {
            parts.push(agValue);
        }

        const result = parts.join('\n');
        if (result) console.log(`📝 Extracted Voice Care Description: "${result}"`);
        return result;
    }
    // ─────────────────────────────────────────────────────────────────────────

    async function setSSOCIncidentSource(container) {
        const subjectSelectors = ['input[data-test-id="omni-header-subject"]', 'input[placeholder="Subject"]', 'input[aria-label="Subject"]', 'input[id*="subject"]'];
        let subjectField = null;
        for (const selector of subjectSelectors) { subjectField = document.querySelector(selector); if (subjectField) break; }
        if (!subjectField) return true;
        const subjectText = subjectField.value.trim();
        if (!subjectText) return true;
        const hasExcludeTag = hasExcludeDetectionTag();
        const hasVoiceCareTagFlag = hasVoiceCareTag();
        const hasApolloTagFlag = hasApolloTag();
        let targetValue, ruleMatched;
        
        const hasReportSafetyText = hasReportSafetyIssueInComments();
        const hasVoiceCareTicket = hasVoiceCareTicketInComments();
        
        if (hasVoiceCareTicket) { targetValue = 'Voice Care'; ruleMatched = 'Voice care ticket'; }
        else if (hasReportSafetyText) { targetValue = 'Voice SSOC'; ruleMatched = 'Selected issue: Report safety issue(s)'; }
        else if (hasVoiceCareTagFlag) { targetValue = 'Voice Care'; ruleMatched = 'ssoc_voice_created_ticket tag'; }
        else if (hasExcludeTag) { targetValue = 'Customer Email'; ruleMatched = 'exclude_detection tag'; }
        else if (hasApolloTagFlag) {
            const currentTicketId = getCurrentTicketId();
            if (currentTicketId) {
                const hasVoiceCareInCommentsFlag = await hasVoiceCareInComments(currentTicketId);
                if (hasVoiceCareInCommentsFlag) { targetValue = 'Voice Care'; ruleMatched = 'voice care found in comments'; }
                else {
                    targetValue = 'Customer Email'; ruleMatched = 'apollo ticket without voice care in comments';
                    const subjectLower = subjectText.toLowerCase();
                    if (subjectLower.includes('dispute')) { targetValue = 'Customer Email'; ruleMatched = 'Dispute'; }
                    else if (subjectLower.includes('contact us')) { targetValue = 'Customer Email'; ruleMatched = 'Contact Us'; }
                }
            } else { targetValue = 'Customer Email'; ruleMatched = 'apollo ticket without ticket ID'; }
        } else {
            targetValue = 'Customer Email'; ruleMatched = 'No special tags - using normal rules';
            const subjectLower = subjectText.toLowerCase();
            if (subjectLower.includes('dispute')) { targetValue = 'Customer Email'; ruleMatched = 'Dispute'; }
            else if (subjectLower.includes('contact us')) { targetValue = 'Customer Email'; ruleMatched = 'Contact Us'; }
        }
        console.log(`📋 Subject matched rule "${ruleMatched}": ${subjectText}`);
        console.log(`🎯 Target SSOC incident source: ${targetValue}`);
        const fields = container.querySelectorAll('[class*="field"], [data-test-id*="field"], div:has(label)');
        let ssocIncidentSourceField = null;
        for (const field of fields) {
            const label = field.querySelector('label');
            if (label && label.textContent.trim() === 'SSOC incident source') { ssocIncidentSourceField = field; break; }
        }
        if (!ssocIncidentSourceField) return true;
        const currentValue = ssocIncidentSourceField.querySelector('[title]')?.getAttribute('title') || ssocIncidentSourceField.querySelector('.StyledEllipsis-sc-1u4umy-0')?.textContent.trim() || ssocIncidentSourceField.querySelector('[data-garden-id="typography.ellipsis"]')?.textContent.trim();
        if (currentValue === targetValue) return true;
        if (currentValue && currentValue !== 'Select an option...' && currentValue !== '-' && ruleMatched !== 'voice care found in comments' && ruleMatched !== 'Selected issue: Report safety issue(s)') return true;
        try { return await setSSOCIncidentSourceWithDebug(ssocIncidentSourceField, targetValue); }
        catch (error) { console.error('❌ Error setting SSOC incident source:', error); return false; }
    }

    function getSelectedCity(container) {
        const fields = container.querySelectorAll('[class*="field"], [data-test-id*="field"], div:has(label)');
        let selectedCity = '';
        Array.from(fields).forEach(field => {
            const label = field.querySelector('label');
            if (label && label.textContent.trim() === 'City') {
                const cityElement = field.querySelector('div[title]');
                if (cityElement) selectedCity = cityElement.getAttribute('title');
                if (!selectedCity) { const ellipsisDiv = field.querySelector('.StyledEllipsis-sc-1u4umy-0'); if (ellipsisDiv) selectedCity = ellipsisDiv.textContent.trim(); }
            }
        });
        return selectedCity;
    }

    // =====================================================================
    // CITY AUTO-FILL — Background prefetch + instant dropdown set
    // =====================================================================

    const cityPrefetchCache = new Map(); // ticketId → { status: 'pending'|'ready'|'failed', city: string|null }

    const ZENDESK_RIDE_ID_CUSTOM_FIELD_ID = 37033787;

    /**
     * Called on every ticket navigation — starts prefetch silently in background.
     * Never blocks UI. Stores result in cityPrefetchCache keyed by ticketId.
     */
    async function prefetchCityForTicket(ticketId) {
        if (!ticketId) return;
        if (cityPrefetchCache.has(ticketId)) return; // already fetching or done

        cityPrefetchCache.set(ticketId, { status: 'pending', city: null });

        try {
            // Step 1: Get ride ID from ticket custom fields
            const ticketResp = await fetch(`/api/v2/tickets/${ticketId}.json`, {
                credentials: 'same-origin',
                headers: { 'X-Requested-With': 'XMLHttpRequest' }
            });
            if (!ticketResp.ok) throw new Error(`Ticket fetch failed: ${ticketResp.status}`);
            const ticketData = await ticketResp.json();

            // Step 2: Extract ride/trip ID from custom field
            const rideId = ticketData?.ticket?.custom_fields?.find(f => f.id === ZENDESK_RIDE_ID_CUSTOM_FIELD_ID)?.value;
            if (!rideId) {
                cityPrefetchCache.set(ticketId, { status: 'failed', city: null });
                return;
            }

            // Step 3: Fetch Apollo route recommended endpoint
            const routeResp = await fetch(
                `https://apollo.careempartner.com/care/rumi-care-service/v1/rides/${rideId}/routes/recommended`,
                { credentials: 'include' }
            );
            if (!routeResp.ok) throw new Error(`Route fetch failed: ${routeResp.status}`);
            const routeData = await routeResp.json();

            // Step 4: Extract ONLY pickup waypoint, ignore dropoff entirely
            const pickup = routeData.waypoints?.find(wp => wp.type === 'pickup');
            if (!pickup) throw new Error('No pickup waypoint found');
            const { latitude, longitude } = pickup;

            // Step 5: Reverse geocode via BigDataCloud
            const geoResp = await fetch(
                `https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${latitude}&longitude=${longitude}&localityLanguage=en`
            );
            if (!geoResp.ok) throw new Error(`Geocode failed: ${geoResp.status}`);
            const geoData = await geoResp.json();

            const city = geoData.city || geoData.locality || geoData.principalSubdivision || null;
            cityPrefetchCache.set(ticketId, { status: 'ready', city });
        } catch (err) {
            cityPrefetchCache.set(ticketId, { status: 'failed', city: null });
        }
    }

    /**
     * Waits for the city prefetch to complete (max 5s), then returns the city string or null.
     * If already ready, returns instantly with zero wait.
     */
    async function awaitPrefetchedCity(ticketId, timeoutMs = 5000) {
        if (!ticketId) return null;
        const start = Date.now();
        while (Date.now() - start < timeoutMs) {
            const entry = cityPrefetchCache.get(ticketId);
            if (!entry) return null;
            if (entry.status === 'ready') return entry.city;
            if (entry.status === 'failed') return null;
            // Still pending — wait a tick
            await new Promise(r => setTimeout(r, 100));
        }
        return null;
    }

    /**
     * Sets the City dropdown field in the form.
     */
    async function setCityField(container, cityValue) {
        if (!cityValue) return true;

        const fields = container.querySelectorAll('[class*="field"], [data-test-id*="field"], div:has(label)');
        let fieldFound = false;

        for (const field of fields) {
            const label = field.querySelector('label');
            if (label && label.textContent.trim() === 'City') {
                if (fieldFound) continue;
                fieldFound = true;

                const currentValue =
                    field.querySelector('[title]')?.getAttribute('title') ||
                    field.querySelector('.StyledEllipsis-sc-1u4umy-0')?.textContent.trim() ||
                    field.querySelector('[data-garden-id="typography.ellipsis"]')?.textContent.trim();

                if (currentValue === cityValue) return true;

                try {
                    return await setDropdownFieldValueInstant(field, cityValue);
                } catch (error) {
                    return false;
                }
            }
        }

        return true;
    }
    
    async function setLanguageField(container, languageValue) {
        if (!languageValue) return true;

        const fields = container.querySelectorAll('[class*="field"], [data-test-id*="field"], div:has(label)');
        let fieldFound = false;

        for (const field of fields) {
            const label = field.querySelector('label');
            if (label && label.textContent.trim() === 'Language') {
                if (fieldFound) continue;
                fieldFound = true;
    
                const currentValue =
                    field.querySelector('[title]')?.getAttribute('title') ||
                    field.querySelector('.StyledEllipsis-sc-1u4umy-0')?.textContent.trim() ||
                    field.querySelector('[data-garden-id="typography.ellipsis"]')?.textContent.trim();
    
                if (currentValue === languageValue) return true;
    
                try {
                    return await setDropdownFieldValueInstant(field, languageValue);
                } catch (error) {
                    return false;
                }
            }
        }
    
        return true;
    }
    
    async function setCountryBasedOnCity(container) {
        const selectedCity = getSelectedCity(container);
        if (!selectedCity || selectedCity === '-') return true;
        console.log(`🏙️ Found city: "${selectedCity}"`);
        const country = rumiEnhancement.cityToCountry.get(selectedCity);
        if (!country) return true;
        console.log(`🌍 Mapped city "${selectedCity}" to country: "${country}"`);
        try {
            const fields = container.querySelectorAll('[class*="field"], [data-test-id*="field"], div:has(label)');
            const promises = [];
            Array.from(fields).forEach(field => {
                const label = field.querySelector('label');
                if (label && label.textContent.trim() === 'Country') {
                    const currentValue = field.querySelector('[title]')?.getAttribute('title') || field.querySelector('.StyledEllipsis-sc-1u4umy-0')?.textContent.trim() || field.querySelector('[data-garden-id="typography.ellipsis"]')?.textContent.trim();
                    if (currentValue && currentValue !== '-' && currentValue === country) return;
                    promises.push(setDropdownFieldValueInstant(field, country));
                }
            });
            if (promises.length > 0) { const results = await Promise.all(promises); return results.every(result => result === true); }
            return true;
        } catch (error) { console.error('❌ Error setting Country field:', error); return false; }
    }

    function getActiveTicketForms(selector, useCache = false, ttl = 1000) {
        let rawElements = Array.from(DOMCache.get(selector, useCache, ttl));
        let active = rawElements.filter(el => el && el.isConnected && el.offsetParent !== null);
        active = active.filter(el => {
            const rect = el.getBoundingClientRect();
            if (rect.width === 0 || rect.height === 0) return false;
            if (rect.right < 0 || rect.bottom < 0 || rect.left > window.innerWidth || rect.top > window.innerHeight) return false;
            return true;
        });
        active = active.filter(el => {
            let parent = el.parentElement;
            while (parent && parent !== document.body) {
                if (parent.hasAttribute('hidden')) return false;
                if (parent.getAttribute('aria-hidden') === 'true') return false;
                if (parent.classList.contains('is-hidden')) return false;
                if (parent.style.display === 'none') return false;
                if (parent.style.visibility === 'hidden') return false;
                if (parent.style.opacity === '0' || parent.style.opacity === '0.01') return false;
                parent = parent.parentElement;
            }
            return true;
        });
        const currentTicketId = window.location.pathname.match(/\/agent\/tickets\/(\d+)/)?.[1];
        if (currentTicketId && active.length > 1) {
            const filteredByEntityId = active.filter(el => {
                let parent = el.parentElement;
                while (parent && parent !== document.body) {
                    const entityId = parent.getAttribute('data-entity-id');
                    if (entityId) return entityId === currentTicketId;
                    parent = parent.parentElement;
                }
                return true;
            });
            if (filteredByEntityId.length > 0 && filteredByEntityId.length < active.length) {
                active = filteredByEntityId;
            } else {
                const switchers = document.querySelectorAll('button[data-test-id="omnichannel-channel-switcher-button"]');
                for (const switcher of switchers) {
                    if (switcher.getAttribute('data-channel-switcher-trigger-for-ticket-id') === currentTicketId && switcher.offsetParent !== null) {
                        let parent = switcher.parentElement;
                        while (parent && parent !== document.body) {
                            if (parent.tagName === 'MAIN' || parent.getAttribute('data-entity-id') || parent.tagName === 'ARTICLE') {
                                const subset = active.filter(el => parent.contains(el));
                                if (subset.length > 0) return subset;
                            }
                            parent = parent.parentElement;
                        }
                    }
                }
            }
        }
        return active;
    }

    async function processRumiAutofill(form, customerWords = '', skipLanguage = false) {
        if (!form || !form.isConnected || observerDisconnected) return;
        try {
            await setSSOCReasonToEscalated(form);
            await new Promise(resolve => setTimeout(resolve, 50));
            await setActionTakenConsumer(form);
            await new Promise(resolve => setTimeout(resolve, 50));
            await setSSOCIncidentSource(form);
            const city = await awaitPrefetchedCity(getCurrentTicketId());
            await setCityField(form, city);
            await new Promise(resolve => setTimeout(resolve, 50));
            if (!skipLanguage) {
                const detectedLang = detectLanguage(customerWords, city || '');
                await setLanguageField(form, detectedLang);
                await new Promise(resolve => setTimeout(resolve, 50));
            }
            await setCountryBasedOnCity(form);
            return true;
        } catch (error) { return false; }
    }
    
    async function processDuplicateAutofill(form, customerWords = '') {
        if (!form || !form.isConnected || observerDisconnected) return;
        try {
            await setReasonToDuplicate(form);
            await new Promise(resolve => setTimeout(resolve, 50));
            await setActionTakenConsumerDuplicate(form);
            await new Promise(resolve => setTimeout(resolve, 50));
            await setSSOCReasonToDuplicate(form);
            await new Promise(resolve => setTimeout(resolve, 50));
            await setSSOCIncidentSource(form);
            const city = await awaitPrefetchedCity(getCurrentTicketId());
            await setCityField(form, city);
            await new Promise(resolve => setTimeout(resolve, 50));
            const detectedLang = detectLanguage(customerWords, city || '');
            await setLanguageField(form, detectedLang);
            await new Promise(resolve => setTimeout(resolve, 50));
            await setCountryBasedOnCity(form);
            return true;
        } catch (error) { return false; }
    }

    async function handleDuplicateTicket() {
        console.log('🚀 Starting duplicate ticket operations');
        let allForms = getActiveTicketForms('section.grid-ticket-fields-panel', true, 2000);
        if (allForms.length === 0) {
            for (const selector of ['section[class*="ticket-fields"]', '[data-test-id*="TicketFieldsPane"]', '.ticket_fields', 'form', '[class*="form"]', 'div[class*="ticket-field"]']) {
                allForms = getActiveTicketForms(selector, false, 1000);
                if (allForms.length > 0) break;
            }
        }
        if (allForms.length > 0) {
            for (let i = 0; i < allForms.length; i++) { try { await processDuplicateAutofill(allForms[i]); if (i < allForms.length - 1) await new Promise(resolve => setTimeout(resolve, 100)); } catch (e) { console.warn('Error:', e); } }
            await new Promise(resolve => setTimeout(resolve, 200));
        }
        const templateText = `Dear team,\n\nWe Have Escalated this case to Uber. Please refer to ticket #\n\nRegards,\n**${username}**\nSafety & Security Operations Team\n`;
        navigator.clipboard.writeText(templateText).then(() => { console.log('✅ Duplicate template copied!'); setTimeout(() => { clickTakeItButton(); }, 300); }).catch(err => { console.error('Failed to copy text:', err); setTimeout(() => { clickTakeItButton(); }, 300); });
    }

    function getCurrentReasonValue() {
        let allForms = document.querySelectorAll('section.grid-ticket-fields-panel');
        if (allForms.length === 0) { for (const selector of ['section[class*="ticket-fields"]', '[data-test-id*="TicketFieldsPane"]', '.ticket_fields', 'form', '[class*="form"]', 'div[class*="ticket-field"]']) { allForms = document.querySelectorAll(selector); if (allForms.length > 0) break; } }
        for (const form of allForms) {
            const fields = form.querySelectorAll('[class*="field"], [data-test-id*="field"], div:has(label)');
            for (const field of fields) {
                const label = field.querySelector('label');
                if (label && (label.textContent.trim() === 'Reason (Quality/GO/Billing)*' || label.textContent.trim() === 'Reason (Quality/GO/Billing)')) { return field.querySelector('[title]')?.getAttribute('title') || field.querySelector('.StyledEllipsis-sc-1u4umy-0')?.textContent.trim() || field.querySelector('[data-garden-id="typography.ellipsis"]')?.textContent.trim() || ''; }
            }
        }
        return '';
    }

    function getCurrentSSOCIncidentSource() {
        let allForms = document.querySelectorAll('section.grid-ticket-fields-panel');
        if (allForms.length === 0) { for (const selector of ['section[class*="ticket-fields"]', '[data-test-id*="TicketFieldsPane"]', '.ticket_fields', 'form', '[class*="form"]', 'div[class*="ticket-field"]']) { allForms = document.querySelectorAll(selector); if (allForms.length > 0) break; } }
        for (const form of allForms) {
            const fields = form.querySelectorAll('[class*="field"], [data-test-id*="field"], div:has(label)');
            for (const field of fields) {
                const label = field.querySelector('label');
                if (label && label.textContent.trim() === 'SSOC incident source') { return field.querySelector('[title]')?.getAttribute('title') || field.querySelector('.StyledEllipsis-sc-1u4umy-0')?.textContent.trim() || field.querySelector('[data-garden-id="typography.ellipsis"]')?.textContent.trim() || ''; }
            }
        }
        return '';
    }

    function parseIncidentTypeFromReason(reasonValue) {
        if (!reasonValue) return '';
        const match = reasonValue.match(/RUMI\s*Safety\s*-\s*(.+)/i);
        if (match && match[1]) { const incidentType = match[1].trim(); console.log(`✅ Found incident type: "${incidentType}"`); return incidentType; }
        return '';
    }

    function determinePhoneSource(ssocIncidentSource) {
        if (!ssocIncidentSource) return 'Yes';
        return ssocIncidentSource.toLowerCase().includes('email') ? 'No' : 'Yes';
    }

    const MOROCCAN_CITIES = ['Casablanca', 'Rabat', 'Tangier'];
    
    const FRENCH_MARKERS = [
        "j'ai", "j'arrive", "j'attends", "j'aimerai", "j'étais",
        "c'est", "n'a pas", "n'est pas", "qu'il", "qu'elle", "m'a","l'application", "l application", "j'ai", "demandé",
        'je suis', 'je veux', 'je dois', 'je ne','il ne', 'il est', 'elle a', 'elle ne', "s'est", 'alors', 'mais',
        'chauffeur', 'conducteur', 'capitaine','voiture', 'trajet', 'espèces','annulé','stylo','puis', 'devez',
        'annuler', 'rembourser', 'remboursé','réclamation', 'arnaque', 'imprévu','panne', 'menteur', 'conduisait',
        'également', 'uniquement','parce que', 'déjà', 'vraiment','toujours', 'jamais', 'maintenant', 'aussi',
        'svp', 'très', 'trop','mal poli', 'bonjour', 'merci', 'bonsoir','dois', 'comprends', 'fumer', 'vrai ', 
        'bloqué', 'bloquée','inquiétant', 'scandale', 'grossier','insulté', 'insulter', 'mensonge', 'sur', 'merci',
        'pourquoi', 'aussi', 'donc', 'alors','après', 'avant', 'retard','pas', 'moi', 'oui', 'non', 'regle', 'autre',
        'bon', 'bien', 'mal', 'peu','tout', 'tous', 'rien', 'plus','prix', 'cher', 'cash', 'Vous', 'sorti', 'dedans',
        'mon', 'ma', 'mes', 'sa','leur', 'nos', 'vos','est', 'sont', 'ont', 'fait', 'une', 'que', 'derniers','refuser',
    ];
    
    function detectLanguage(text, city = '') {
        if (!text || !text.trim()) return 'English';
    
        const arabicCount = (text.match(/[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/g) || []).length;
        const totalNonSpace = (text.match(/\S/g) || []).length || 1;
        if (arabicCount / totalNonSpace > 0.10) return 'Arabic';
    
        if (MOROCCAN_CITIES.includes(city)) {
            const lowerText = ' ' + text.toLowerCase() + ' ';
    
            let frenchScore = 0;
            for (const marker of FRENCH_MARKERS) {
                if (marker.includes("'") || marker.includes(' ')) {
                    if (lowerText.includes(marker)) frenchScore++;
                } else {
                    if (lowerText.includes(' ' + marker + ' ') ||
                        lowerText.includes(' ' + marker + ',') ||
                        lowerText.includes(' ' + marker + '.') ||
                        lowerText.includes(' ' + marker + '!') ||
                        lowerText.includes(' ' + marker + '?')) {
                        frenchScore++;
                    }
                }
            }
    
            console.log(`🇫🇷 French score: ${frenchScore} for city: ${city}`);
            if (frenchScore >= 2) return 'French';
        }
    
        return 'English';
    }


    function createTextInput(rumiButton) {
        const existingInput = document.querySelector('.rumi-text-input');
        if (existingInput) existingInput.remove();
        const input = document.createElement('textarea');
        input.className = 'rumi-text-input';
        input.style.cssText = `position: absolute; width: 30px; height: 20px; font-size: 12px; border: 1px solid #ccc; border-radius: 3px; padding: 2px; margin-left: 35px; z-index: 1000; background: white; resize: none; overflow: hidden;`;
        input.placeholder = '';
        input.title = 'Paste customer text here';
        const rumiButtonRect = rumiButton.getBoundingClientRect();
        input.style.position = 'fixed';
        input.style.left = (rumiButtonRect.right + 5) + 'px';
        input.style.top = (rumiButtonRect.top + (rumiButtonRect.height - 20) / 2) + 'px';
        document.body.appendChild(input);
        setTimeout(() => { input.focus(); input.select(); }, 50);
        return input;
    }

    function removeTextInput() { const input = document.querySelector('.rumi-text-input'); if (input) input.remove(); }

    async function generateDynamicTemplateText(customerWords = '', customerLanguage = '', explicitReasonValue = null) {
        const reasonValue = explicitReasonValue || getCurrentReasonValue();
        const ssocIncidentSource = getCurrentSSOCIncidentSource();
        const hasExcludeTag = hasExcludeDetectionTag();
        const hasVoiceCareTagFlag = hasVoiceCareTag();
        const hasApolloTagFlag = hasApolloTag();
        const currentTicketId = getCurrentTicketId();
        const incidentType = parseIncidentTypeFromReason(reasonValue);
        let phoneSource;
        if (hasExcludeTag) phoneSource = 'No';
        else phoneSource = determinePhoneSource(ssocIncidentSource);
        const incidentTypeLine = incidentType ? `Incident Type: ${incidentType}\u00A0` : 'Incident Type:\u00A0';
        const phoneSourceLine = `Is the Source of incident CareemInboundPhone :- ${phoneSource}\u00A0`;
        const customerLanguageLine = customerLanguage ? `Customer Language: ${customerLanguage}\u00A0` : 'Customer Language:\u00A0';
        const customerWordsLine = customerWords ? `Customer Words: ${customerWords.split('\n').filter(l => l.trim()).join('\n')}\u00A0` : 'Customer Words:\u00A0';
        let descriptionLine;
        if (customerLanguage === 'French') {
            descriptionLine = `Description:\u00A0Safety Case`;
        } else if (hasExcludeTag) {
            descriptionLine = `Description:\u00A0Customer is complaining about,\u00A0 (Social media ticket #${currentTicketId})`;
        } else if (hasVoiceCareTagFlag) {
            descriptionLine = `Description:\u00A0Customer is complaining about,\u00A0 (Voice care ticket #${currentTicketId})`;
        } else if (hasApolloTagFlag && currentTicketId) {
            const hasVoiceCareInCommentsFlag = await hasVoiceCareInComments(currentTicketId);
            descriptionLine = hasVoiceCareInCommentsFlag
                ? `Description:\u00A0Customer is complaining about,\u00A0 (Voice care ticket #${currentTicketId})`
                : 'Description:\u00A0Customer is complaining about,\u00A0 ';
        } else {
            descriptionLine = 'Description:\u00A0Customer is complaining about,\u00A0 ';
        }
        return `${incidentTypeLine}\n    ${descriptionLine}\n    ${phoneSourceLine}\n    ${customerLanguageLine}\n    ${customerWordsLine}`;
    }

    function isTicketAlreadyAssigned() {
        const assigneeSelectors = ['[data-test-id="assignee-field-current-assignee"]', '[data-test-id="assignee-field"] [title]', '.assignee-field [title]', '[aria-label*="assignee"] [title]', '[aria-label*="Assignee"] [title]'];
        let currentAssignee = null;
        for (const selector of assigneeSelectors) { const element = document.querySelector(selector); if (element) { currentAssignee = element.getAttribute('title') || element.textContent.trim(); if (currentAssignee) break; } }
        if (!currentAssignee) return false;
        if (username && currentAssignee.toLowerCase().includes(username.toLowerCase())) return true;
        return false;
    }

    function getCurrentTicketId() {
        const match = window.location.pathname.match(/\/agent\/tickets\/(\d+)/);
        return match ? match[1] : null;
    }

    const QUICK_ASSIGN_BUTTONS = [
        { id: 'not-safety-related-button', label: 'Not Safety', groupId: 20705088, comment: 'Not SSOC Related' },
        { id: 'hq-button', label: 'HQ', groupId: 20705088, comment: null },
        { id: 'hq-morocco-button', label: 'HQ-Morocco', groupId: 360011852054, comment: null },
        { id: 'outreach-button', label: 'Outreach', groupId: 15293095561619, comment: null },
        { id: 'mot-button', label: 'MOT', groupId: 360000210487, comment: null },
        { id: 'mot-ssoc-button', label: 'MOT SSOC', groupId: 25862683237139, comment: null },
        { id: 'rta-jv-button', label: 'RTA-JV', groupId: 360003368353, comment: null },
        { id: 'shadow-button', label: 'Shadow', groupId: 34373129086483, comment: null },
        { id: 'food-button', label: 'Food', groupId: 360016462353, comment: null },
        { id: 'bike-button', label: 'Bike', groupId: 360007090594, comment: null },
        { id: 'captain-button', label: 'Captain', groupId: 28216988, comment: null },
        { id: 'no-booking-button', label: 'No Booking', groupId: 20705088, comment: 'No Booking ID' }
    ];

    async function assignToGroup(groupId, groupName, comment = null) {
        const ticketId = getCurrentTicketId();
        if (!ticketId) { showExportToast('Error: No ticket ID found'); return; }
        try {
            const csrfToken = RUMIZendeskAPI.getCSRFToken();
            if (!csrfToken) throw new Error('CSRF token not found');
            const payload = { ticket: { group_id: groupId } };
            if (comment) payload.ticket.comment = { body: comment, public: false };
            const response = await fetch(`/api/v2/tickets/${ticketId}.json`, { method: "PUT", headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken, "X-Requested-With": "XMLHttpRequest" }, body: JSON.stringify(payload) });
            if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
            const data = await response.json();
            showExportToast(`Assigned to ${groupName}`);
            return data;
        } catch (error) { console.error(`❌ Failed to assign ticket to ${groupName}:`, error); showExportToast('Error: Failed to assign'); throw error; }
    }

    function createQuickAssignButton(config, isFirst = false) {
        const button = document.createElement('button');
        button.setAttribute('type', 'button');
        button.setAttribute('data-test-id', config.id);
        button.setAttribute('title', `Double-click to assign to ${config.label}`);
        button.textContent = config.label;
        button.style.cssText = `display: inline-flex; align-items: center; justify-content: center; box-sizing: border-box; background-color: transparent; border: 1px solid #c2c8cc; border-radius: 4px; color: #2f3941; cursor: pointer; font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif; font-size: 12px; font-weight: 400; line-height: 18px; padding: 5px 10px; transition: border-color 0.25s ease-in-out, box-shadow 0.1s ease-in-out, background-color 0.25s ease-in-out, color 0.25s ease-in-out; white-space: nowrap; text-decoration: none; user-select: none; overflow: hidden; text-overflow: ellipsis; flex-shrink: 0;`;
        button.addEventListener('mouseenter', () => { button.style.borderColor = '#5293c7'; button.style.color = '#1f73b7'; });
        button.addEventListener('mouseleave', () => { button.style.borderColor = '#c2c8cc'; button.style.color = '#2f3941'; button.style.boxShadow = 'none'; });
        button.addEventListener('focus', () => { button.style.outline = 'none'; button.style.boxShadow = '0 0 0 3px rgba(31, 115, 183, 0.35)'; });
        button.addEventListener('blur', () => { button.style.boxShadow = 'none'; });
        button.addEventListener('mousedown', () => { button.style.borderColor = '#1f73b7'; button.style.backgroundColor = 'rgba(31, 115, 183, 0.08)'; });
        button.addEventListener('mouseup', () => { button.style.backgroundColor = 'transparent'; });
        button.addEventListener('dblclick', async (e) => {
            e.preventDefault(); e.stopPropagation();
            button.disabled = true; button.style.opacity = '0.5'; button.style.cursor = 'default';
            const originalText = button.textContent; button.textContent = 'Processing...';
            try { await assignToGroup(config.groupId, config.label, config.comment); } finally { button.disabled = false; button.style.opacity = '1'; button.style.cursor = 'pointer'; button.textContent = originalText; }
        });
        return button;
    }

    function createQuickAssignContainer() {
        const container = document.createElement('div');
        container.setAttribute('data-test-id', 'quick-assign-container');
        container.className = 'quick-assign-container';
        container.style.cssText = `display: inline-flex; align-items: center; gap: 8px; padding: 4px 0; position: relative; flex-shrink: 0; flex-grow: 0; vertical-align: middle; min-width: fit-content;`;
        const toggleButton = document.createElement('button');
        toggleButton.setAttribute('type', 'button');
        toggleButton.setAttribute('aria-label', 'Toggle quick assign buttons');
        toggleButton.innerHTML = `<span class="toggle-icon">▼</span><span class="toggle-label">Quick Assign</span>`;
        toggleButton.style.cssText = `display: inline-flex; align-items: center; gap: 6px; background-color: transparent; border: 1px solid #c2c8cc; border-radius: 4px; color: #2f3941; cursor: pointer; font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif; font-size: 13px; font-weight: 500; line-height: 20px; padding: 6px 12px; transition: all 0.2s ease-in-out; user-select: none; flex-shrink: 0;`;
        toggleButton.addEventListener('mouseenter', () => { toggleButton.style.borderColor = '#5293c7'; toggleButton.style.color = '#1f73b7'; });
        toggleButton.addEventListener('mouseleave', () => { toggleButton.style.borderColor = '#c2c8cc'; toggleButton.style.color = '#2f3941'; });
        const buttonsWrapper = document.createElement('div');
        buttonsWrapper.setAttribute('data-test-id', 'quick-assign-buttons-wrapper');
        buttonsWrapper.style.cssText = `display: flex; align-items: center; gap: 6px; flex-wrap: nowrap; padding: 2px 0; transition: opacity 0.2s ease-in-out, width 0.2s ease-in-out; overflow-x: auto; overflow-y: hidden; scrollbar-width: none; -ms-overflow-style: none; flex-shrink: 0;`;
        if (!document.getElementById('quick-assign-scrollbar-hide')) {
            const style = document.createElement('style');
            style.id = 'quick-assign-scrollbar-hide';
            style.textContent = `.quick-assign-buttons-wrapper::-webkit-scrollbar { display: none; }`;
            document.head.appendChild(style);
        }
        QUICK_ASSIGN_BUTTONS.forEach((config) => { buttonsWrapper.appendChild(createQuickAssignButton(config, false)); });
        const icon = toggleButton.querySelector('.toggle-icon');
        icon.style.cssText = `display: inline-block; transition: transform 0.2s ease-in-out; font-size: 10px;`;
        let isExpanded = true;
        toggleButton.addEventListener('click', (e) => {
            e.preventDefault(); e.stopPropagation(); isExpanded = !isExpanded;
            if (isExpanded) { buttonsWrapper.style.display = 'flex'; buttonsWrapper.style.visibility = 'visible'; buttonsWrapper.style.opacity = '1'; buttonsWrapper.style.width = 'auto'; buttonsWrapper.style.maxWidth = 'none'; buttonsWrapper.style.pointerEvents = 'auto'; icon.style.transform = 'rotate(0deg)'; toggleButton.setAttribute('aria-expanded', 'true'); }
            else { buttonsWrapper.style.display = 'flex'; buttonsWrapper.style.visibility = 'hidden'; buttonsWrapper.style.opacity = '0'; buttonsWrapper.style.width = '0'; buttonsWrapper.style.maxWidth = '0'; buttonsWrapper.style.overflow = 'hidden'; buttonsWrapper.style.pointerEvents = 'none'; buttonsWrapper.style.margin = '0'; buttonsWrapper.style.padding = '0'; icon.style.transform = 'rotate(-90deg)'; toggleButton.setAttribute('aria-expanded', 'false'); }
        });
        toggleButton.setAttribute('aria-expanded', 'true');
        container.appendChild(toggleButton);
        container.appendChild(buttonsWrapper);
        return container;
    }

    function insertQuickAssignButtons() {
        const footerSections = document.querySelectorAll('[data-test-id="ticket-footer-open-ticket"]');
        footerSections.forEach(footer => {
            if (footer.querySelector('[data-test-id="quick-assign-container"]')) return;
            const rightButtonsContainer = footer.querySelector('[class*="sc-177ytgv-1"]');
            const fieldContainer = footer.querySelector('[data-garden-id="forms.field"]') || footer.querySelector('[class*="Field"]') || footer.querySelector('[class*="field"]');
            let insertAfterElement = null;
            if (fieldContainer) insertAfterElement = fieldContainer;
            else {
                const children = Array.from(footer.children);
                if (rightButtonsContainer) { const rightIndex = children.indexOf(rightButtonsContainer); if (rightIndex > 0) insertAfterElement = children[rightIndex - 1]; }
                else insertAfterElement = footer.firstElementChild;
            }
            const container = createQuickAssignContainer();
            if (!document.getElementById('quick-assign-position-fix')) {
                const style = document.createElement('style');
                style.id = 'quick-assign-position-fix';
                style.textContent = `[data-test-id="quick-assign-container"] { order: 0 !important; margin-right: auto !important; }`;
                document.head.appendChild(style);
            }
            if (insertAfterElement) insertAfterElement.insertAdjacentElement('afterend', container);
            else if (rightButtonsContainer) footer.insertBefore(container, rightButtonsContainer);
            else footer.insertBefore(container, footer.firstChild);
            console.log('✅ Quick assign buttons container inserted into footer');
        });
    }

    function insertNotSafetyRelatedButton() { insertQuickAssignButtons(); }

    function showExportToast(message = 'Exported') {
        const existingToast = document.querySelector('.export-toast');
        if (existingToast) existingToast.remove();
        const toast = document.createElement('div');
        toast.className = 'export-toast';
        toast.textContent = message;
        toast.style.cssText = `position: fixed; top: 20px; right: 20px; background-color: #333333; color: white; padding: 12px 20px; border-radius: 4px; font-size: 14px; z-index: 10000; box-shadow: 0 2px 8px rgba(0, 0, 0, 0.2); animation: exportToastSlide 0.3s ease-out;`;
        if (!document.getElementById('export-toast-styles')) {
            const style = document.createElement('style');
            style.id = 'export-toast-styles';
            style.textContent = `@keyframes exportToastSlide { from { opacity: 0; transform: translateX(100%); } to { opacity: 1; transform: translateX(0); } }`;
            document.head.appendChild(style);
        }
        document.body.appendChild(toast);
        setTimeout(() => { if (toast && toast.parentElement) { toast.style.animation = 'exportToastSlide 0.3s ease-out reverse'; setTimeout(() => toast.remove(), 300); } }, 2000);
    }

    let _cachedCurrentUserId = null;

    /**
     * Assign the ticket to the current user via Zendesk API.
     * Primary method: PUT /api/v2/tickets/:id.json with assignee_id.
     * Retries up to 3 times with 500ms delay, then falls back to DOM clickTakeItButton.
     */
    async function assignTicketToMe(ticketId) {
        if (!ticketId) {
            console.warn('⚠️ assignTicketToMe: No ticket ID provided, falling back to DOM click');
            clickTakeItButton();
            return;
        }

        // First check if already assigned
        if (isTicketAlreadyAssigned()) {
            console.log('✅ Ticket already assigned to current user, skipping assignment');
            return;
        }

        // Get current user ID (cached after first call)
        if (!_cachedCurrentUserId) {
            try {
                const resp = await fetch('/api/v2/users/me.json', {
                    credentials: 'same-origin',
                    headers: { 'X-Requested-With': 'XMLHttpRequest' }
                });
                if (resp.ok) {
                    const data = await resp.json();
                    _cachedCurrentUserId = data.user.id;
                    console.log(`👤 Cached current user ID: ${_cachedCurrentUserId}`);
                } else {
                    console.warn(`⚠️ Failed to get current user: HTTP ${resp.status}`);
                    clickTakeItButton();
                    return;
                }
            } catch (err) {
                console.warn('⚠️ Error fetching current user:', err);
                clickTakeItButton();
                return;
            }
        }

        // Attempt API-based assignment with retries
        const maxRetries = 3;
        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                const csrfToken = RUMIZendeskAPI.getCSRFToken();
                const resp = await fetch(`/api/v2/tickets/${ticketId}.json`, {
                    method: 'PUT',
                    credentials: 'same-origin',
                    headers: {
                        'Content-Type': 'application/json',
                        'X-CSRF-Token': csrfToken || '',
                        'X-Requested-With': 'XMLHttpRequest'
                    },
                    body: JSON.stringify({ ticket: { assignee_id: _cachedCurrentUserId } })
                });

                if (resp.ok) {
                    console.log(`✅ Ticket ${ticketId} assigned via API (attempt ${attempt})`);
                    return; // Success!
                }

                console.warn(`⚠️ API assignment attempt ${attempt} failed: HTTP ${resp.status}`);
            } catch (err) {
                console.warn(`⚠️ API assignment attempt ${attempt} error:`, err);
            }

            // Wait before retry (except on last attempt)
            if (attempt < maxRetries) {
                await new Promise(r => setTimeout(r, 500));
            }
        }

        // All API attempts failed — fall back to DOM click
        console.warn('⚠️ All API assignment attempts failed, falling back to DOM click');
        clickTakeItButton();
    }

    // Function to find and click the "take it" button
    function clickTakeItButton() {
        // First check if ticket is already assigned to current user
        if (isTicketAlreadyAssigned()) {
            console.log('✅ Ticket already assigned to current user, skipping assignment');
            return;
        }

        console.log('🎯 Looking for "take it" button within active workspace...');

        // Try multiple selectors to find the "take it" button
        const selectors = [
            'button[data-test-id="assignee-field-take-it-button"]',
            '.bCIuZx',
            'button[class*="bCIuZx"]'
        ];

        let takeItButton = null;

        for (const selector of selectors) {
            const rawButtons = Array.from(document.querySelectorAll(selector));

            // Filter strictly like getActiveTicketForms
            let activeBtns = rawButtons.filter(el => el && el.isConnected && el.offsetParent !== null);
            activeBtns = activeBtns.filter(el => {
                const rect = el.getBoundingClientRect();
                if (rect.width === 0 || rect.height === 0) return false;
                if (rect.right < 0 || rect.bottom < 0 || rect.left > window.innerWidth || rect.top > window.innerHeight) return false;
                return true;
            });
            activeBtns = activeBtns.filter(el => {
                let parent = el.parentElement;
                while (parent && parent !== document.body) {
                    if (parent.hasAttribute('hidden')) return false;
                    if (parent.getAttribute('aria-hidden') === 'true') return false;
                    if (parent.style.display === 'none') return false;
                    if (parent.style.visibility === 'hidden') return false;
                    if (parent.style.opacity === '0' || parent.style.opacity === '0.01') return false;
                    parent = parent.parentElement;
                }
                return true;
            });

            if (activeBtns.length > 0) {
                // EXTREME SCOPING: Enforce data-entity-id matching if it exists in the parent tree
                const currentTicketId = window.location.pathname.match(/\/agent\/tickets\/(\d+)/)?.[1];
                if (currentTicketId) {
                    activeBtns = activeBtns.filter(el => {
                        let parent = el.parentElement;
                        while (parent && parent !== document.body) {
                            const entityId = parent.getAttribute('data-entity-id') || parent.getAttribute('data-channel-switcher-trigger-for-ticket-id');
                            if (entityId) {
                                // If we hit a ticket container, it MUST match the URL ticket ID
                                return entityId === currentTicketId;
                            }
                            parent = parent.parentElement;
                        }
                        // If no ticket container was found in tree, it's global, so safe
                        return true;
                    });
                }

                if (activeBtns.length > 0) {
                    takeItButton = activeBtns[0];
                    console.log(`✅ Found visible "take it" button using selector: ${selector}`);
                    break;
                }
            }
        }

        // Try the :contains fallback if still not found
        if (!takeItButton) {
            const allButtons = Array.from(document.querySelectorAll('button')).filter(btn => btn.textContent.trim().toLowerCase() === 'take it');
            let activeBtns = allButtons.filter(el => el && el.isConnected && el.offsetParent !== null);
            activeBtns = activeBtns.filter(el => {
                const rect = el.getBoundingClientRect();
                if (rect.width === 0 || rect.height === 0) return false;
                if (rect.right < 0 || rect.bottom < 0 || rect.left > window.innerWidth || rect.top > window.innerHeight) return false;
                return true;
            });
            activeBtns = activeBtns.filter(el => {
                let parent = el.parentElement;
                while (parent && parent !== document.body) {
                    if (parent.hasAttribute('hidden')) return false;
                    if (parent.getAttribute('aria-hidden') === 'true') return false;
                    if (parent.style.display === 'none') return false;
                    if (parent.style.visibility === 'hidden') return false;
                    if (parent.style.opacity === '0' || parent.style.opacity === '0.01') return false;
                    parent = parent.parentElement;
                }
                return true;
            });
            if (activeBtns.length > 0) {
                const currentTicketId = window.location.pathname.match(/\/agent\/tickets\/(\d+)/)?.[1];
                if (currentTicketId) {
                    activeBtns = activeBtns.filter(el => {
                        let parent = el.parentElement;
                        while (parent && parent !== document.body) {
                            const entityId = parent.getAttribute('data-entity-id') || parent.getAttribute('data-channel-switcher-trigger-for-ticket-id');
                            if (entityId) {
                                return entityId === currentTicketId;
                            }
                            parent = parent.parentElement;
                        }
                        return true;
                    });
                }

                if (activeBtns.length > 0) {
                    takeItButton = activeBtns[0];
                    console.log('✅ Found visible "take it" button using text match');
                }
            }
        }

        if (takeItButton) {
            try {
                console.log('🖱️ Clicking "take it" button...');
                if (takeItButton.offsetParent !== null && !takeItButton.disabled) {
                    takeItButton.click();
                    console.log('✅ "take it" button clicked successfully');
                } else {
                    console.log('⚠️ "take it" button found but not clickable (hidden or disabled)');
                }
            } catch (error) {
                console.error('❌ Error clicking "take it" button:', error);
            }
        } else {
            console.log('⚠️ "take it" button not found actively visible on the page');
        }
    }

    function copyRumi(buttonElement) {
        console.log('🚀 RUMI clicked');
        const existingInput = document.querySelector('.rumi-text-input');
        if (existingInput) { removeTextInput(); return; }

        const textInput = createTextInput(buttonElement);
        textInput.addEventListener('keydown', async (event) => {
            if ((event.ctrlKey || event.metaKey) && (event.key === 'v' || event.key === 'V' || event.key === 'ر')) {
                setTimeout(async () => {
                    const pastedText = textInput.value.trim();
                    removeTextInput();
                    if (pastedText) {
                    const city = await awaitPrefetchedCity(getCurrentTicketId());
                    const customerLanguage = detectLanguage(pastedText, city || '');
                    await performRumiOperations(pastedText, customerLanguage);
                    }
                    else await performRumiOperations('', '');
                }, 10);
            } else if (event.key === 'Enter') {
                const enteredText = textInput.value.trim(); removeTextInput();
                const city = await awaitPrefetchedCity(getCurrentTicketId());
                await performRumiOperations(enteredText, detectLanguage(enteredText, city || ''));
            } else if (event.key === 'Escape') { removeTextInput(); }
        });
    }

    async function performRumiOperations(customerWords, customerLanguage) {
        const ticketId = getCurrentTicketId();
        const assignmentPromise = ticketId
            ? new Promise(resolve => { setTimeout(() => { clickTakeItButton(); resolve(); }, 200); })
            : Promise.resolve();
    
        let allForms = getActiveTicketForms('section.grid-ticket-fields-panel', true, 2000);
        if (allForms.length === 0) {
            for (const selector of ['section[class*="ticket-fields"]', '[data-test-id*="TicketFieldsPane"]', '.ticket_fields', 'form', '[class*="form"]', 'div[class*="ticket-field"]']) {
                allForms = getActiveTicketForms(selector, false, 1000);
                if (allForms.length > 0) break;
            }
        }
        if (allForms.length > 0) {
            for (let i = 0; i < allForms.length; i++) {
                try {
                    await processRumiAutofill(allForms[i], customerWords); // ← pass here
                    if (i < allForms.length - 1) await new Promise(resolve => setTimeout(resolve, 100));
                } catch (e) { console.warn('Error:', e); }
            }
            await new Promise(resolve => setTimeout(resolve, 200));
        }
    
        const templateText = await generateDynamicTemplateText(customerWords, customerLanguage);
        try { await navigator.clipboard.writeText(templateText); }
        catch (err) { console.error('Failed to copy text:', err); }
    
        await assignmentPromise;
    }


    function createRumiButton() {
        const wrapper = document.createElement('div');
        wrapper.className = 'sc-ymabb7-1 fTDEYw';
        const button = document.createElement('button');
        button.setAttribute('aria-pressed', 'false'); button.setAttribute('aria-label', 'RUMI'); button.setAttribute('data-test-id', 'rumi-button'); button.setAttribute('data-active', 'false'); button.setAttribute('title', 'RUMI'); button.setAttribute('tabindex', '0');
        button.className = 'StyledButton-sc-qe3ace-0 StyledIconButton-sc-1t0ughp-0 eUFUgT iQoDao sc-k83b6s-0 ihwxVG';
        button.setAttribute('data-garden-id', 'buttons.icon_button'); button.setAttribute('data-garden-version', '9.7.0'); button.setAttribute('type', 'button');
        const iconDiv = document.createElement('div'); iconDiv.className = 'rumi-icon'; iconDiv.innerHTML = uberLogoSVG;
        const svg = iconDiv.querySelector('svg'); svg.setAttribute('aria-hidden', 'true'); svg.setAttribute('focusable', 'false'); svg.setAttribute('data-garden-id', 'buttons.icon'); svg.setAttribute('data-garden-version', '9.7.0'); svg.setAttribute('class', 'StyledBaseIcon-sc-1moykgb-0 StyledIcon-sc-19meqgg-0 eWlVPJ cxMMcO');
        button.appendChild(iconDiv); button.style.opacity = '0.85';
        button.addEventListener('click', function (e) { e.preventDefault(); e.stopPropagation(); copyRumi(button); });
        wrapper.appendChild(button); return wrapper;
    }

    function createDuplicateButton() {
        const wrapper = document.createElement('div');
        wrapper.className = 'sc-ymabb7-1 fTDEYw';
        const button = document.createElement('button');
        button.setAttribute('aria-pressed', 'false'); button.setAttribute('aria-label', 'Duplicate Ticket'); button.setAttribute('data-test-id', 'duplicate-button'); button.setAttribute('title', 'Mark as Duplicate Ticket'); button.setAttribute('tabindex', '0');
        button.className = 'StyledButton-sc-qe3ace-0 StyledIconButton-sc-1t0ughp-0 eUFUgT iQoDao sc-k83b6s-0 ihwxVG';
        button.setAttribute('data-garden-id', 'buttons.icon_button'); button.setAttribute('data-garden-version', '9.7.0'); button.setAttribute('type', 'button');
        const iconDiv = document.createElement('div'); iconDiv.className = 'duplicate-icon'; iconDiv.innerHTML = duplicateIconSVG;
        const svg = iconDiv.querySelector('svg'); svg.setAttribute('aria-hidden', 'true'); svg.setAttribute('focusable', 'false'); svg.setAttribute('class', 'StyledBaseIcon-sc-1moykgb-0 StyledIcon-sc-19meqgg-0 eWlVPJ cxMMcO'); svg.style.width = '16px'; svg.style.height = '16px';
        button.appendChild(iconDiv); button.style.opacity = '0.85';
        button.addEventListener('click', function (e) {
            e.preventDefault(); e.stopPropagation();
            const existingTicketInput = document.querySelector('.rumi-text-input');
            if (existingTicketInput) { existingTicketInput.remove(); return; }
            (function createTicketIdInput(dupButton) {
                const prior = document.querySelector('.rumi-text-input'); if (prior) prior.remove();
                const ti = createTextInput(dupButton); ti.placeholder = ''; ti.removeAttribute('title'); ti.className = 'rumi-text-input';
                const processDupWithId = async (pastedId) => {
                    let allForms = getActiveTicketForms('section.grid-ticket-fields-panel', true, 2000);
                    if (allForms.length === 0) { for (const selector of ['section[class*="ticket-fields"]', '[data-test-id*="TicketFieldsPane"]', '.ticket_fields', 'form', '[class*="form"]', 'div[class*="ticket-field"]']) { allForms = getActiveTicketForms(selector, false, 1000); if (allForms.length > 0) break; } }
                    if (allForms.length > 0) { for (let i = 0; i < allForms.length; i++) { try { await processDuplicateAutofill(allForms[i]); if (i < allForms.length - 1) await new Promise(r => setTimeout(r, 100)); } catch (_) { } } await new Promise(r => setTimeout(r, 200)); }
                    const templateText = `Dear team,\n\nWe Have Escalated this case to Uber. Please refer to ticket #${pastedId}\n\nRegards,\n**${username}**\nSafety & Security Operations Team\n`;
                    navigator.clipboard.writeText(templateText).then(() => { setTimeout(() => { clickTakeItButton(); }, 300); }).catch(err => { setTimeout(() => { clickTakeItButton(); }, 300); });
                };
                ti.addEventListener('keydown', async (ke) => {
                    if ((ke.ctrlKey || ke.metaKey) && (ke.key === 'v' || ke.key === 'V' || ke.key === 'ر')) { setTimeout(async () => { const pastedId = ti.value.trim(); ti.remove(); await processDupWithId(pastedId); }, 10); }
                    else if (ke.key === 'Enter') { ke.preventDefault(); const enteredId = ti.value.trim(); ti.remove(); await processDupWithId(enteredId); }
                    else if (ke.key === 'Escape') { ke.preventDefault(); ti.remove(); }
                });
            })(button);
        });
        wrapper.appendChild(button); return wrapper;
    }

    function toggleAllFields() {
        debounce(() => {
            let allForms = DOMCache.get('section.grid-ticket-fields-panel', true, 2000);
            if (allForms.length === 0) { for (const selector of ['section[class*="ticket-fields"]', '[data-test-id*="TicketFieldsPane"]', '.ticket_fields', 'form', '[class*="form"]', 'div[class*="ticket-field"]']) { allForms = DOMCache.get(selector, false, 1000); if (allForms.length > 0) break; } }
            if (allForms.length === 0) return;
            fieldVisibilityState = (fieldVisibilityState === 'all') ? 'minimal' : 'all';
            saveFieldVisibilityState();
            requestAnimationFrame(() => {
                allForms.forEach(form => {
                    if (!form || !form.children || !form.isConnected) return;
                    const allPossibleFields = Array.from(form.querySelectorAll('[data-garden-id="forms.field"], .StyledField-sc-12gzfsu-0, [class*="field"], [data-test-id*="field"], div:has(label)'));
                    const fields = [];
                    allPossibleFields.forEach(field => { try { if (!field.nodeType === Node.ELEMENT_NODE || !field.isConnected || !field.querySelector('label')) return; if (isSystemField(field)) return; if (fields.includes(field)) return; fields.push(field); } catch (e) { } });
                    const fieldsToHide = []; const fieldsToShow = [];
                    fields.forEach(field => { try { if (fieldVisibilityState === 'all') fieldsToShow.push(field); else if (isTargetField(field)) fieldsToShow.push(field); else fieldsToHide.push(field); } catch (e) { } });
                    fieldsToHide.forEach(field => { try { field.classList.add('hidden-form-field'); } catch (e) { } });
                    fieldsToShow.forEach(field => { try { field.classList.remove('hidden-form-field'); } catch (e) { } });
                });
                updateToggleButtonState();
            });
        }, 100, 'toggleAllFields');
    }

    function updateToggleButtonState() {
        if (!globalButton) return;
        const button = globalButton.querySelector('button');
        if (!button) return;
        const iconSvg = button.querySelector('svg');
        if (iconSvg) {
            let newSvg, title, text;
            if (fieldVisibilityState === 'all') { newSvg = eyeOpenSVG; title = 'Showing All Fields - Click for Minimal View'; text = 'All Fields'; }
            else { newSvg = eyeClosedSVG; title = 'Showing Minimal Fields - Click for All Fields'; text = 'Minimal'; }
            iconSvg.outerHTML = newSvg;
            const newIcon = button.querySelector('svg');
            if (newIcon) { newIcon.setAttribute('width', '26'); newIcon.setAttribute('height', '26'); newIcon.setAttribute('data-garden-id', 'chrome.nav_item_icon'); newIcon.setAttribute('data-garden-version', '9.5.2'); newIcon.classList.add('StyledBaseIcon-sc-1moykgb-0', 'StyledNavItemIcon-sc-7w9rpt-0', 'eWlVPJ', 'YOjtB'); }
            button.setAttribute('title', title);
            const textSpan = button.querySelector('span');
            if (textSpan) textSpan.textContent = text;
        }
    }

    function createToggleButton() {
        const listItem = document.createElement('li');
        listItem.className = 'nav-list-item';
        const button = document.createElement('button');
        button.className = 'form-toggle-icon StyledBaseNavItem-sc-zvo43f-0 StyledNavButton-sc-f5ux3-0 gvFgbC dXnFqH';
        button.setAttribute('tabindex', '0'); button.setAttribute('data-garden-id', 'chrome.nav_button'); button.setAttribute('data-garden-version', '9.5.2');
        const iconWrapper = document.createElement('div'); iconWrapper.style.display = 'flex'; iconWrapper.style.alignItems = 'center';
        const icon = document.createElement('div'); icon.innerHTML = eyeOpenSVG;
        icon.firstChild.setAttribute('width', '26'); icon.firstChild.setAttribute('height', '26'); icon.firstChild.setAttribute('data-garden-id', 'chrome.nav_item_icon'); icon.firstChild.setAttribute('data-garden-version', '9.5.2');
        icon.firstChild.classList.add('StyledBaseIcon-sc-1moykgb-0', 'StyledNavItemIcon-sc-7w9rpt-0', 'eWlVPJ', 'YOjtB');
        const text = document.createElement('span'); text.textContent = 'All Fields'; text.className = 'StyledNavItemText-sc-13m84xl-0 iOGbGR'; text.setAttribute('data-garden-id', 'chrome.nav_item_text'); text.setAttribute('data-garden-version', '9.5.2');
        iconWrapper.appendChild(icon); iconWrapper.appendChild(text); button.appendChild(iconWrapper); listItem.appendChild(button);
        return listItem;
    }

    function createSeparator() { const separator = document.createElement('li'); separator.className = 'nav-separator'; return separator; }

    // ============================================================================
    // PQMS SUBMISSION
    // ============================================================================

    let pqmsButton = null;
    let isSubmittingToPQMS = false;

    async function submitToPQMS(ticketStatus = 'Solved') {
        try {
            if (isSubmittingToPQMS) { showPQMSToast('Error: A submission is already in progress', 'error'); return; }
            const ticketId = getCurrentTicketId();
            if (!ticketId || !/^\d+$/.test(ticketId.toString())) { showPQMSToast('Error: Could not get valid Ticket ID', 'error'); return; }
            const validStatuses = ['Open', 'Pending', 'Solved'];
            if (!validStatuses.includes(ticketStatus)) { showPQMSToast(`Error: Invalid ticket status "${ticketStatus}"`, 'error'); return; }
            const selectedUser = getPQMSSelectedUser();
            if (!selectedUser || !selectedUser.opsId || !selectedUser.name) { showPQMSToast('Error: Please select an OPS ID in the dashboard first', 'error'); return; }
            if (!PQMS_USERS[selectedUser.opsId]) { showPQMSToast(`Error: Invalid OPS ID "${selectedUser.opsId}"`, 'error'); return; }
            if (selectedUser.name !== PQMS_USERS[selectedUser.opsId]) { showPQMSToast(`Error: Name mismatch for OPS ID ${selectedUser.opsId}`, 'error'); return; }
            isSubmittingToPQMS = true;
            showPQMSToast('Submitting to PQMS...', 'info');
            const params = new URLSearchParams({ 'Ticket_ID': ticketId.toString(), 'SSOC_Reason': 'Felt Unsafe', 'Ticket_Type': 'Non - Critical', 'Ticket_Status': ticketStatus, 'Attempts': 'NA', 'Escelated': '', 'Follow_Up': '', 'Comments': '', 'username': selectedUser.opsId, 'name': selectedUser.name });
            const url = `https://pqms05.extensya.com/Careem/ticket/submit_SSOC_ticket.php?${params.toString()}`;
            const iframe = document.createElement('iframe');
            iframe.style.cssText = 'display: none; width: 0; height: 0; border: none;';
            let loadTimeout;
            const loadPromise = new Promise((resolve, reject) => {
                iframe.onload = () => { clearTimeout(loadTimeout); resolve(); };
                iframe.onerror = () => { clearTimeout(loadTimeout); reject(new Error('Failed to load PQMS endpoint')); };
                loadTimeout = setTimeout(() => { reject(new Error('Request timeout')); }, 10000);
            });
            document.body.appendChild(iframe); iframe.src = url;
            try {
                await loadPromise;
                showPQMSToast(`✓ Ticket ${ticketId} submitted to PQMS as ${ticketStatus}`, 'success');
                fetchTicketData(ticketId).then(({ subject, groupName }) => { savePQMSSubmission(ticketId, subject, groupName, ticketStatus); }).catch(() => { });
            } catch (loadError) {
                showPQMSToast(`→ Ticket ${ticketId} sent to PQMS as ${ticketStatus}`, 'info');
                fetchTicketData(ticketId).then(({ subject, groupName }) => { savePQMSSubmission(ticketId, subject, groupName, ticketStatus); }).catch(() => { });
            } finally { setTimeout(() => { if (iframe && iframe.parentNode) iframe.parentNode.removeChild(iframe); }, 1000); }
        } catch (error) {
            console.error('PQMS CRITICAL ERROR:', error);
            showPQMSToast(`Error: Submission failed - ${error.message}`, 'error');
            const existingIframe = document.querySelector('iframe[src*="pqms05.extensya.com"]');
            if (existingIframe && existingIframe.parentNode) existingIframe.parentNode.removeChild(existingIframe);
        } finally { setTimeout(() => { isSubmittingToPQMS = false; }, 2000); }
    }

    function showPQMSToast(message, type = 'info') {
        const toast = document.createElement('div');
        toast.style.cssText = `position: fixed; top: 20px; right: 20px; padding: 15px 20px; background-color: ${type === 'success' ? '#28a745' : type === 'error' ? '#dc3545' : '#007bff'}; color: white; border-radius: 5px; box-shadow: 0 4px 6px rgba(0,0,0,0.1); z-index: 10000; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; font-size: 14px; max-width: 400px; animation: slideIn 0.3s ease-out;`;
        toast.textContent = message;
        const style = document.createElement('style');
        style.textContent = `@keyframes slideIn { from { transform: translateX(100%); opacity: 0; } to { transform: translateX(0); opacity: 1; } }`;
        document.head.appendChild(style);
        document.body.appendChild(toast);
        setTimeout(() => { toast.style.animation = 'slideIn 0.3s ease-out reverse'; setTimeout(() => { toast.remove(); style.remove(); }, 300); }, 3000);
    }

    const PQMS_USERS = {
        '32951': 'Bader Alzoubi', '40268': 'Nader Mohammad Qasim Abujalil', '37862': 'Husam Ahmad Ibrahim Alnajy',
        '48463': 'Mohammed Karout', '48423': 'Haitham Raed Khaled Altraini', '45719': 'Nour Khaled Yousef Rawashdeh',
        '51048': 'Ayham Ahmad Asad Alsari', '51049': 'Zaid Mohammad Hussein Banihani', '55649': 'Idries Alomari',
        '55670': 'Amin Alshraiedeh', '55616': 'Mohammad dalgamouni',
    };

    const PQMS_USER_STORAGE_KEY = 'pqms_selected_user';
    const PQMS_HISTORY_STORAGE_KEY = 'pqms_submission_history';

    function getPQMSHistory() { try { const saved = localStorage.getItem(PQMS_HISTORY_STORAGE_KEY); return saved ? JSON.parse(saved) : []; } catch (e) { return []; } }

    function savePQMSSubmission(ticketId, ticketSubject, groupName, status) {
        const history = getPQMSHistory();
        history.unshift({ ticketId, ticketSubject, groupName, status, timestamp: new Date().toISOString(), submittedBy: getPQMSSelectedUser()?.name || 'Unknown' });
        if (history.length > 500) history.splice(500);
        localStorage.setItem(PQMS_HISTORY_STORAGE_KEY, JSON.stringify(history));
    }

    function getPQMSSelectedUser() { try { const saved = localStorage.getItem(PQMS_USER_STORAGE_KEY); if (saved) { const userData = JSON.parse(saved); if (PQMS_USERS[userData.opsId]) return userData; } } catch (e) { } return null; }
    function savePQMSSelectedUser(opsId, name) { localStorage.setItem(PQMS_USER_STORAGE_KEY, JSON.stringify({ opsId, name })); }
    function clearPQMSSelectedUser() { localStorage.removeItem(PQMS_USER_STORAGE_KEY); }

    async function fetchTicketSubject(ticketId) { try { const response = await fetch(`/api/v2/tickets/${ticketId}.json`); if (!response.ok) throw new Error('Failed'); const data = await response.json(); return data.ticket.subject || 'Unknown Subject'; } catch (error) { return 'Unknown Subject'; } }
    async function fetchGroupName(groupId) { try { if (!groupId) return 'No Group'; const response = await fetch(`/api/v2/groups/${groupId}.json`); if (!response.ok) throw new Error('Failed'); const data = await response.json(); return data.group.name || 'Unknown Group'; } catch (error) { return 'Unknown Group'; } }
    async function fetchTicketData(ticketId) { try { const response = await fetch(`/api/v2/tickets/${ticketId}.json`); if (!response.ok) throw new Error('Failed'); const data = await response.json(); const subject = data.ticket.subject || 'Unknown Subject'; const groupId = data.ticket.group_id; let groupName = 'No Group'; if (groupId) groupName = await fetchGroupName(groupId); return { subject, groupName }; } catch (error) { return { subject: 'Unknown Subject', groupName: 'Unknown Group' }; } }

    function togglePQMSDashboard() {
        const existingDashboard = document.getElementById('pqms-dashboard');
        if (existingDashboard) { existingDashboard.style.display = existingDashboard.style.display === 'none' ? 'flex' : 'none'; return; }
        createPQMSDashboard();
    }

    function createPQMSDashboard() {
        const dashboard = document.createElement('div');
        dashboard.id = 'pqms-dashboard';
        dashboard.style.cssText = `position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%); width: 800px; max-width: 95%; height: 85vh; min-height: 600px; max-height: 90vh; background: #ffffff; border: 1px solid #d1d5db; border-radius: 8px; box-shadow: 0 20px 25px -5px rgba(0, 0, 0, 0.1); z-index: 100000; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif; display: flex; flex-direction: column; overflow: hidden;`;
        const header = document.createElement('div');
        header.style.cssText = `background: #f9fafb; border-bottom: 1px solid #e5e7eb; padding: 18px 24px; display: flex; justify-content: space-between; align-items: center;`;
        header.innerHTML = `<div style="display: flex; align-items: center; gap: 10px;"><span style="font-size: 20px; color: #4b5563;">⚙</span><span style="font-size: 18px; font-weight: 600; color: #111827; letter-spacing: -0.025em;">PQMS Dashboard</span></div><div style="display: flex; gap: 8px; align-items: center;"><button id="pqms-settings-btn" style="background: transparent; border: none; color: #6b7280; width: 32px; height: 32px; border-radius: 4px; cursor: pointer; font-size: 18px; display: flex; align-items: center; justify-content: center;">⚙</button><button id="pqms-close-btn" style="background: transparent; border: none; color: #6b7280; width: 32px; height: 32px; border-radius: 4px; cursor: pointer; font-size: 24px; display: flex; align-items: center; justify-content: center;">&times;</button></div>`;
        const content = document.createElement('div');
        content.style.cssText = `padding: 24px; display: flex; flex-direction: column; gap: 24px; background: #ffffff; overflow-y: auto; flex: 1; min-height: 0;`;
        const currentUser = getPQMSSelectedUser();
        const isUserSelected = !!currentUser;
        const history = getPQMSHistory();
        const counters = { all: history.length, open: history.filter(h => h.status === 'Open').length, pending: history.filter(h => h.status === 'Pending').length, solved: history.filter(h => h.status === 'Solved').length };
        const countersSection = document.createElement('div');
        countersSection.style.cssText = `display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin-bottom: 24px;`;
        [{ label: 'All', count: counters.all, color: '#6b7280' }, { label: 'Open', count: counters.open, color: '#9ca3af' }, { label: 'Pending', count: counters.pending, color: '#9ca3af' }, { label: 'Solved', count: counters.solved, color: '#22c55e' }].forEach(item => {
            const counter = document.createElement('div');
            counter.style.cssText = `background: #f9fafb; border: 1px solid #e5e7eb; border-radius: 6px; padding: 12px; text-align: center;`;
            counter.innerHTML = `<div style="font-size: 24px; font-weight: 700; color: ${item.color}; line-height: 1; margin-bottom: 4px;">${item.count}</div><div style="font-size: 11px; font-weight: 600; color: #6b7280; text-transform: uppercase; letter-spacing: 0.05em;">${item.label}</div>`;
            countersSection.appendChild(counter);
        });
        const historySection = document.createElement('div');
        historySection.style.cssText = `margin-top: 24px; padding-top: 24px; border-top: 1px solid #e5e7eb;`;
        const historyHeader = document.createElement('div');
        historyHeader.style.cssText = `font-weight: 600; margin-bottom: 12px; color: #374151; font-size: 13px; text-transform: uppercase; letter-spacing: 0.025em;`;
        historyHeader.textContent = 'Submission History';
        const historyTable = document.createElement('div');
        historyTable.style.cssText = `border: 1px solid #e5e7eb; border-radius: 6px; overflow: hidden; max-height: 400px; overflow-y: auto; background: #ffffff; min-height: 300px;`;
        if (history.length === 0) {
            historyTable.innerHTML = `<div style="padding: 40px 20px; text-align: center; color: #9ca3af; font-size: 13px;">No submissions yet</div>`;
        } else {
            const table = document.createElement('table');
            table.style.cssText = `width: 100%; border-collapse: collapse; font-size: 13px;`;
            table.innerHTML = `<thead><tr style="background: #f9fafb; border-bottom: 1px solid #e5e7eb;"><th style="padding: 10px 12px; text-align: left; font-weight: 600; color: #6b7280; text-transform: uppercase; font-size: 11px; letter-spacing: 0.05em;">Ticket</th><th style="padding: 10px 12px; text-align: left; font-weight: 600; color: #6b7280; text-transform: uppercase; font-size: 11px; letter-spacing: 0.05em;">Subject</th><th style="padding: 10px 12px; text-align: left; font-weight: 600; color: #6b7280; text-transform: uppercase; font-size: 11px; letter-spacing: 0.05em;">Group</th><th style="padding: 10px 12px; text-align: center; font-weight: 600; color: #6b7280; text-transform: uppercase; font-size: 11px; letter-spacing: 0.05em;">Status</th></tr></thead><tbody></tbody>`;
            const tbody = table.querySelector('tbody');
            history.slice(0, 250).forEach((item, index) => {
                const row = document.createElement('tr');
                row.style.borderBottom = index < Math.min(history.length - 1, 249) ? '1px solid #f3f4f6' : 'none';
                const statusColor = item.status === 'Solved' ? '#166534' : '#6b7280';
                const statusBg = item.status === 'Solved' ? '#dcfce7' : '#f3f4f6';
                row.innerHTML = `<td style="padding: 10px 12px; color: #111827; font-weight: 500; font-family: 'Courier New', monospace;">#${item.ticketId}</td><td style="padding: 10px 12px; color: #374151; max-width: 200px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;" title="${item.ticketSubject}">${item.ticketSubject}</td><td style="padding: 10px 12px; color: #6b7280; font-size: 12px;">${item.groupName}</td><td style="padding: 10px 12px; text-align: center;"><span style="display: inline-block; padding: 3px 10px; background: ${statusBg}; color: ${statusColor}; border-radius: 12px; font-size: 11px; font-weight: 600;">${item.status}</span></td>`;
                tbody.appendChild(row);
            });
            historyTable.appendChild(table);
        }
        historySection.appendChild(historyHeader); historySection.appendChild(historyTable);
        content.appendChild(countersSection); content.appendChild(historySection);
        dashboard.appendChild(header); dashboard.appendChild(content);
        const settingsPanel = document.createElement('div');
        settingsPanel.id = 'pqms-settings-panel';
        settingsPanel.style.cssText = `position: absolute; top: 0; right: 0; width: 300px; height: 100%; background: #ffffff; border-left: 1px solid #e5e7eb; padding: 24px; transform: translateX(100%); transition: transform 0.3s ease; z-index: 100001; overflow-y: auto;`;
        const opsSection = document.createElement('div');
        opsSection.innerHTML = `<label style="display: block; font-weight: 600; margin-bottom: 8px; color: #374151; font-size: 13px; text-transform: uppercase; letter-spacing: 0.025em;">OPS ID</label><select id="pqms-ops-select" style="width: 100%; padding: 12px; border: 1px solid #d1d5db; border-radius: 6px; font-size: 14px; background: ${isUserSelected ? '#f9fafb' : '#ffffff'}; cursor: ${isUserSelected ? 'not-allowed' : 'pointer'}; color: ${isUserSelected ? '#9ca3af' : '#111827'}; font-family: 'Courier New', monospace; font-weight: 500; min-height: 44px;" ${isUserSelected ? 'disabled' : ''}><option value="">Select an OPS ID</option>${Object.keys(PQMS_USERS).map(opsId => `<option value="${opsId}" ${currentUser?.opsId === opsId ? 'selected' : ''}>${opsId}</option>`).join('')}</select>`;
        const nameSection = document.createElement('div');
        nameSection.innerHTML = `<label style="display: block; font-weight: 600; margin-bottom: 8px; color: #374151; font-size: 13px; text-transform: uppercase; letter-spacing: 0.025em;">Full Name</label><div id="pqms-name-display" style="width: 100%; padding: 10px 12px; border: 1px solid #d1d5db; border-radius: 6px; font-size: 14px; background: #f9fafb; color: ${currentUser ? '#111827' : '#9ca3af'}; min-height: 42px; display: flex; align-items: center; font-weight: 500;">${currentUser ? currentUser.name : 'No operator selected'}</div>`;
        const buttonSection = document.createElement('div');
        buttonSection.style.cssText = `display: flex; gap: 10px; margin-top: 4px; padding-top: 20px; border-top: 1px solid #e5e7eb;`;
        if (isUserSelected) buttonSection.innerHTML = `<button id="pqms-unchoose-btn" style="flex: 1; padding: 10px 18px; background: #ffffff; color: #dc2626; border: 1px solid #dc2626; border-radius: 6px; font-size: 14px; font-weight: 600; cursor: pointer;">Clear Selection</button>`;
        else buttonSection.innerHTML = `<button id="pqms-select-btn" style="flex: 1; padding: 10px 18px; background: #111827; color: #ffffff; border: 1px solid #111827; border-radius: 6px; font-size: 14px; font-weight: 600; cursor: pointer;">Confirm Selection</button>`;
        const settingsContent = document.createElement('div');
        settingsContent.style.cssText = `display: flex; flex-direction: column; gap: 24px;`;
        settingsContent.innerHTML = `<div style="display: flex; justify-content: space-between; align-items: center;"><h3 style="font-size: 16px; font-weight: 600; color: #111827; margin: 0;">Settings</h3><button id="pqms-settings-close" style="background: transparent; border: none; color: #6b7280; width: 24px; height: 24px; cursor: pointer; font-size: 18px; display: flex; align-items: center; justify-content: center;">&times;</button></div>`;
        settingsContent.appendChild(opsSection); settingsContent.appendChild(nameSection); settingsContent.appendChild(buttonSection);
        settingsPanel.appendChild(settingsContent); dashboard.appendChild(settingsPanel);
        const backdrop = document.createElement('div');
        backdrop.id = 'pqms-dashboard-backdrop';
        backdrop.style.cssText = `position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0, 0, 0, 0.4); backdrop-filter: blur(2px); z-index: 99999;`;
        document.body.appendChild(backdrop); document.body.appendChild(dashboard);
        document.getElementById('pqms-close-btn').addEventListener('click', closePQMSDashboard);
        document.getElementById('pqms-settings-btn').addEventListener('click', function () { const panel = document.getElementById('pqms-settings-panel'); panel.style.transform = panel.style.transform === 'translateX(100%)' ? 'translateX(0)' : 'translateX(100%)'; });
        document.getElementById('pqms-settings-close').addEventListener('click', function () { document.getElementById('pqms-settings-panel').style.transform = 'translateX(100%)'; });
        backdrop.addEventListener('click', closePQMSDashboard);
        const opsSelect = document.getElementById('pqms-ops-select');
        opsSelect.addEventListener('change', function () { const nameDisplay = document.getElementById('pqms-name-display'); if (this.value && PQMS_USERS[this.value]) { nameDisplay.textContent = PQMS_USERS[this.value]; nameDisplay.style.color = '#111827'; } else { nameDisplay.textContent = 'No operator selected'; nameDisplay.style.color = '#9ca3af'; } });
        const selectBtn = document.getElementById('pqms-select-btn');
        if (selectBtn) { selectBtn.addEventListener('click', function () { const opsSelect = document.getElementById('pqms-ops-select'); const selectedOpsId = opsSelect.value; if (!selectedOpsId) { showPQMSToast('Please select an OPS ID', 'error'); return; } savePQMSSelectedUser(selectedOpsId, PQMS_USERS[selectedOpsId]); showPQMSToast(`User selected: ${PQMS_USERS[selectedOpsId]}`, 'success'); closePQMSDashboard(); setTimeout(() => createPQMSDashboard(), 100); }); }
        const unchooseBtn = document.getElementById('pqms-unchoose-btn');
        if (unchooseBtn) { unchooseBtn.addEventListener('click', function () { clearPQMSSelectedUser(); showPQMSToast('User unselected', 'info'); closePQMSDashboard(); setTimeout(() => createPQMSDashboard(), 100); }); }
        const escapeHandler = (e) => { if (e.key === 'Escape') { closePQMSDashboard(); document.removeEventListener('keydown', escapeHandler); } };
        document.addEventListener('keydown', escapeHandler);
    }

    function closePQMSDashboard() { const dashboard = document.getElementById('pqms-dashboard'); const backdrop = document.getElementById('pqms-dashboard-backdrop'); if (dashboard) dashboard.remove(); if (backdrop) backdrop.remove(); }

    function showPQMSStatusMenu(event) {
        if (event) { event.preventDefault(); event.stopPropagation(); }
        const existingMenu = document.getElementById('pqms-status-menu');
        if (existingMenu) { closePQMSStatusMenu(); return; }
        const pqmsButtonEl = event?.currentTarget || document.querySelector('.pqms-button');
        if (!pqmsButtonEl) return;
        const buttonRect = pqmsButtonEl.getBoundingClientRect();
        const menu = document.createElement('div');
        menu.id = 'pqms-status-menu';
        menu.style.cssText = `position: fixed; left: ${buttonRect.right + 12}px; top: ${buttonRect.top}px; background: #ffffff; border: 1px solid #d1d5db; border-radius: 6px; box-shadow: 0 4px 16px rgba(0, 0, 0, 0.12); z-index: 100001; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif; min-width: 220px; overflow: hidden;`;
        menu.innerHTML = `<div style="background: #f9fafb; border-bottom: 1px solid #e5e7eb; padding: 10px 16px; font-size: 12px; font-weight: 600; color: #6b7280; text-transform: uppercase; letter-spacing: 0.5px;">Select Status</div>`;
        const optionsContainer = document.createElement('div');
        optionsContainer.style.padding = '4px 0';
        [{ name: 'Open', shortcut: 'Alt+O', icon: '○' }, { name: 'Pending', shortcut: 'Alt+P', icon: '◐' }, { name: 'Solved', shortcut: 'Alt+S', icon: '⏺' }].forEach((status, index) => {
            const item = document.createElement('button');
            item.style.cssText = `width: 100%; padding: 10px 16px; background: transparent; border: none; border-bottom: ${index < 2 ? '1px solid #f3f4f6' : 'none'}; cursor: pointer; display: flex; justify-content: space-between; align-items: center; font-size: 14px; color: #1f2937; text-align: left;`;
            item.innerHTML = `<div style="display: flex; align-items: center; gap: 10px;"><span style="font-size: 16px; color: #6b7280; width: 20px; text-align: center;">${status.icon}</span><span style="font-weight: 500;">${status.name}</span></div><span style="font-size: 11px; color: #9ca3af; font-family: 'Courier New', monospace; background: #f3f4f6; padding: 2px 6px; border-radius: 3px;">${status.shortcut}</span>`;
            item.addEventListener('click', () => { closePQMSStatusMenu(); submitToPQMS(status.name); });
            item.addEventListener('mouseenter', function () { this.style.backgroundColor = '#f3f4f6'; });
            item.addEventListener('mouseleave', function () { this.style.backgroundColor = 'transparent'; });
            optionsContainer.appendChild(item);
        });
        menu.appendChild(optionsContainer);
        const backdrop = document.createElement('div');
        backdrop.id = 'pqms-status-menu-backdrop';
        backdrop.style.cssText = `position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: transparent; z-index: 100000;`;
        document.body.appendChild(backdrop); document.body.appendChild(menu);
        backdrop.addEventListener('click', closePQMSStatusMenu);
        const escapeHandler = (e) => { if (e.key === 'Escape') { closePQMSStatusMenu(); document.removeEventListener('keydown', escapeHandler); } };
        document.addEventListener('keydown', escapeHandler);
    }

    function closePQMSStatusMenu() { const menu = document.getElementById('pqms-status-menu'); const backdrop = document.getElementById('pqms-status-menu-backdrop'); if (menu) menu.remove(); if (backdrop) backdrop.remove(); }

    const pqmsSVG = `<svg xmlns="http://www.w3.org/2000/svg" width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="17 8 12 3 7 8"></polyline><line x1="12" y1="3" x2="12" y2="15"></line></svg>`;

    function createPQMSButton() {
        const listItem = document.createElement('li'); listItem.className = 'nav-list-item';
        const button = document.createElement('button');
        button.className = 'pqms-button StyledBaseNavItem-sc-zvo43f-0 StyledNavButton-sc-f5ux3-0 gvFgbC dXnFqH';
        button.setAttribute('tabindex', '0'); button.setAttribute('data-garden-id', 'chrome.nav_button'); button.setAttribute('data-garden-version', '9.5.2'); button.setAttribute('title', 'Submit to PQMS as "Felt Unsafe"');
        const iconWrapper = document.createElement('div'); iconWrapper.style.cssText = 'display: flex; align-items: center;';
        const icon = document.createElement('div'); icon.innerHTML = pqmsSVG;
        icon.firstChild.setAttribute('width', '26'); icon.firstChild.setAttribute('height', '26'); icon.firstChild.setAttribute('data-garden-id', 'chrome.nav_item_icon'); icon.firstChild.setAttribute('data-garden-version', '9.5.2');
        icon.firstChild.classList.add('StyledBaseIcon-sc-1moykgb-0', 'StyledNavItemIcon-sc-7w9rpt-0', 'eWlVPJ', 'YOjtB');
        const text = document.createElement('span'); text.textContent = 'Submit PQMS'; text.className = 'StyledNavItemText-sc-13m84xl-0 iOGbGR'; text.setAttribute('data-garden-id', 'chrome.nav_item_text'); text.setAttribute('data-garden-version', '9.5.2');
        iconWrapper.appendChild(icon); iconWrapper.appendChild(text); button.appendChild(iconWrapper); listItem.appendChild(button);
        return listItem;
    }

    function tryAddToggleButton() {
        const navLists = document.querySelectorAll('ul[data-garden-id="chrome.nav_list"]');
        const navList = navLists[navLists.length - 1];
        if (!navList) return;

        // Reset references if elements were detached by SPA re-render
        if (globalButton && !globalButton.isConnected) globalButton = null;
        if (pqmsButton && !pqmsButton.isConnected) pqmsButton = null;

        // Add separator once
        if (!globalButton && !navList.querySelector('[data-rumi-separator]')) {
            const separator = createSeparator();
            separator.setAttribute('data-rumi-separator', 'true');
            navList.appendChild(separator);
        }

        // Add eye toggle button
        if (!globalButton) {
            globalButton = createToggleButton();
            globalButton.querySelector('button').addEventListener('click', toggleAllFields);
            navList.appendChild(globalButton);
        }

        // Add PQMS button (submit icon) under the eye button — opens status quick-pick
        if (!pqmsButton) {
            pqmsButton = createPQMSButton();
            pqmsButton.querySelector('button').addEventListener('click', showPQMSStatusMenu);
            navList.appendChild(pqmsButton);
        }
    }

    /**
     * Attaches the PQMS Dashboard to the Zendesk icon in the bottom-left nav.
     * Copied exactly from Reference.js createRUMIEnhancementOverlayButton().
     * Uses data-test-id="zendesk_icon" and multiple fallback selectors.
     */
    let cachedZendeskIcon = null;

    function createRUMIEnhancementOverlayButton() {
        if (cachedZendeskIcon && cachedZendeskIcon.isConnected && cachedZendeskIcon.dataset.rumiEnhanced === 'true') {
            return true;
        }

        const selectors = [
            'div[title="Zendesk"][data-test-id="zendesk_icon"]',
            'div[data-test-id="zendesk_icon"]',
            'div[title="Zendesk"]',
            '.StyledBrandmarkNavItem-sc-8kynd4-0',
            'div[data-garden-id="chrome.brandmark_nav_list_item"]'
        ];

        let zendeskIcon = null;
        let matchedSelector = null;
        for (const selector of selectors) {
            zendeskIcon = document.querySelector(selector);
            if (zendeskIcon) {
                matchedSelector = selector;
                break;
            }
        }

        if (!zendeskIcon) return false;

        // Check if already enhanced
        if (zendeskIcon.dataset.rumiEnhanced === 'true') {
            cachedZendeskIcon = zendeskIcon;
            return true;
        }

        // Mark as enhanced to prevent duplicate handlers
        zendeskIcon.dataset.rumiEnhanced = 'true';
        cachedZendeskIcon = zendeskIcon;

        // Update title to hint at PQMS
        const originalTitle = zendeskIcon.getAttribute('title') || 'Zendesk';
        zendeskIcon.setAttribute('title', `${originalTitle} - Click for PQMS Dashboard`);

        // Add visual indicator (kept invisible like Reference.js)
        const indicator = document.createElement('div');
        indicator.innerHTML = '🤖';
        indicator.style.cssText = `
            position: absolute !important;
            top: -3px !important;
            right: -3px !important;
            font-size: 8px !important;
            z-index: 10000 !important;
            pointer-events: none !important;
            opacity: 0 !important;
            display: none !important;
        `;
        zendeskIcon.style.position = 'relative';
        zendeskIcon.appendChild(indicator);

        // Left-click opens PQMS Dashboard
        zendeskIcon.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            togglePQMSDashboard();
        });

        zendeskIcon.addEventListener('mouseenter', () => { indicator.style.opacity = '1'; });
        zendeskIcon.addEventListener('mouseleave', () => { indicator.style.opacity = '0.8'; });

        console.log('✅ PQMS: Zendesk icon enhanced for PQMS Dashboard access');
        return true;
    }

    function tryAttachPQMSToZendeskIcon(attempts = 0) {
        if (createRUMIEnhancementOverlayButton()) return;
        if (attempts < 15) setTimeout(() => tryAttachPQMSToZendeskIcon(attempts + 1), 500);
        else console.warn('⚠️ PQMS: Could not attach to Zendesk icon after max attempts');
    }

    // ============================================================================
    // RUMI SAFETY HEADER BUTTONS
    // ============================================================================

    const RUMI_SAFETY_BUTTONS = [
        { label: 'Potential', reason: 'RUMI Safety - Potential Safety Concern case', dropdownValue: 'Potential Safety Concern case' },
        { label: 'Dangerous', reason: 'RUMI Safety - Dangerous Driving case', dropdownValue: 'Dangerous Driving case' },
        { label: 'Law', reason: 'RUMI Safety - Law Enforcement / Regulatory case', dropdownValue: 'Law Enforcement / Regulatory case' },
        { label: 'Verbal', reason: 'RUMI Safety - Verbal Altercation case', dropdownValue: 'Verbal Altercation case' },
        { label: 'Theft', reason: 'RUMI Safety - Theft or Robbery case', dropdownValue: 'Theft or Robbery case' },
        { label: 'Sexual', reason: 'RUMI Safety - Sexual assault / Misconduct case', dropdownValue: 'Sexual assault / Misconduct case' },
        { label: 'Contact', reason: 'RUMI Safety - Inappropriate Post-Trip Contact / Media Upload', dropdownValue: 'Inappropriate Post-Trip Contact / Media Upload' },
        { label: 'Crash', reason: 'RUMI Safety - Vehicle Crash or Claim case', dropdownValue: 'Vehicle Crash or Claim case' },
        { label: 'Substance', reason: 'RUMI Safety - Substance Abuse case', dropdownValue: 'Substance Abuse case' },
        { label: 'Physical', reason: 'RUMI Safety - Physical Altercation case', dropdownValue: 'Physical Altercation case' },
        { label: 'Health', reason: 'RUMI Safety - Health / Self-Harm case', dropdownValue: 'Health / Self-Harm case' },
    ];

    async function setSafetyReasonDropdown(fieldContainer, targetText) {
        const trigger = fieldContainer.querySelector('[role="combobox"]') || fieldContainer.querySelector('input[data-test-id="ticket-field-input"]') || fieldContainer.querySelector('input');
        if (!trigger) return false;
        trigger.focus(); trigger.click();
        await new Promise(r => setTimeout(r, 250));
        const allOptions = Array.from(document.querySelectorAll('[role="option"], [data-test-id="ticket-field-option"]')).filter(o => o.isConnected);
        if (allOptions.length === 0) { trigger.blur(); return false; }
        console.log(`📋 RUMI Safety: ${allOptions.length} Reason options visible:`, allOptions.map(o => `"${o.textContent.trim()}"`).join(', '));
        const target = targetText.trim().toLowerCase();
        let match = allOptions.find(o => o.textContent.trim() === targetText);
        if (!match) match = allOptions.find(o => o.textContent.trim().toLowerCase() === target);
        if (!match) match = allOptions.find(o => o.textContent.trim().toLowerCase().includes(target));
        if (!match) match = allOptions.find(o => target.includes(o.textContent.trim().toLowerCase()));
        if (match) { console.log(`✅ RUMI Safety: Clicking option "${match.textContent.trim()}"`); match.click(); await new Promise(r => setTimeout(r, 100)); return true; }
        console.warn(`❌ RUMI Safety: No option matched "${targetText}"`); trigger.blur(); return false;
    }

    function setReactInputValue(element, value) {
        try {
            const nativeInputValueSetter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), 'value');
            if (nativeInputValueSetter && nativeInputValueSetter.set) nativeInputValueSetter.set.call(element, value);
            else element.value = value;
            element.dispatchEvent(new Event('input', { bubbles: true })); element.dispatchEvent(new Event('change', { bubbles: true }));
        } catch (e) { element.value = value; element.dispatchEvent(new Event('input', { bubbles: true })); element.dispatchEvent(new Event('change', { bubbles: true })); }
    }

    async function selectZendeskDropdownOption(inputElement, value) {
        inputElement.focus(); inputElement.click(); setReactInputValue(inputElement, value);
        await new Promise(r => setTimeout(r, 250));
        inputElement.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40, which: 40, bubbles: true }));
        await new Promise(r => setTimeout(r, 100));
        inputElement.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
    }

    function extractSocialMediaIssueRaised(plainBody) {
        if (!plainBody) return '';

        // Find "Issue raised" then grab from the ":" after it to the next ":"
        const issueRaisedIdx = plainBody.indexOf('Issue raised');
        if (issueRaisedIdx === -1) return '';

        const firstColon = plainBody.indexOf(':', issueRaisedIdx);
        if (firstColon === -1) return '';

        const secondColon = plainBody.indexOf(':', firstColon + 1);
        if (secondColon === -1) return '';

        // Slice between first colon (inclusive) and second colon (inclusive)
        let extracted = plainBody.slice(firstColon, secondColon + 1);

        // Strip from the last \n\n to end
        const lastDoubleNewline = extracted.lastIndexOf('\n\n');
        if (lastDoubleNewline !== -1) {
            extracted = extracted.slice(0, lastDoubleNewline);
        }

        // Remove leading ":" and clean up \n\n
        extracted = extracted
            .replace(/^:/, '')           // remove leading colon
            .replace(/\n\n/g, ' ')       // replace double newlines with space
            .trim();

        return extracted;
    }

    /**
     * Main click handler for a safety button.
     * CRITICAL: apolloWindowRef is pre-opened synchronously BEFORE any await.
     */
    async function handleSafetyButtonClick(reasonValue, clickedBtn) {
        console.log(`🛡️ RUMI Safety: Button clicked — "${reasonValue}"`);

        // --- Visual feedback ---
        const container = document.getElementById('rumi-safety-buttons-container');
        if (container) container.querySelectorAll('.rumi-safety-btn').forEach(b => b.classList.remove('rumi-safety-active'));
        if (clickedBtn) clickedBtn.classList.add('rumi-safety-active');

        const ticketId = getTicketIdFromUrl();
        if (!ticketId) console.warn('RUMI Safety: Could not determine ticket ID from URL');

        const assignmentPromise = ticketId ? new Promise(resolve => { setTimeout(() => { clickTakeItButton(); resolve(); }, 200); }) : Promise.resolve();

        // Branch 1: Dropdown + Autofill
        const formFillPromise = (async () => {
            const dropdownText = (clickedBtn && clickedBtn._dropdownValue) ? clickedBtn._dropdownValue : reasonValue;
            let safetyForms = getActiveTicketForms('section.grid-ticket-fields-panel', true, 2000);
            if (safetyForms.length === 0) { for (const sel of ['section[class*="ticket-fields"]', '[data-test-id*="TicketFieldsPane"]', '.ticket_fields', 'form', '[class*="form"]', 'div[class*="ticket-field"]']) { safetyForms = getActiveTicketForms(sel, false, 1000); if (safetyForms.length > 0) break; } }
            let reasonSet = false;
            for (const form of safetyForms) {
                const fields = form.querySelectorAll('[class*="field"], [data-test-id*="field"], div:has(label)');
                for (const field of fields) {
                    const label = field.querySelector('label');
                    if (!label) continue;
                    const labelText = label.textContent.trim();
                    if (labelText === 'Reason (Quality/GO/Billing)*' || labelText === 'Reason (Quality/GO/Billing)') {
                        const ok = await setSafetyReasonDropdown(field, dropdownText);
                        console.log(`${ok ? '✅' : '❌'} RUMI Safety: Reason set result: ${ok ? 'SUCCESS' : 'FAILED'}`);
                        reasonSet = true; break;
                    }
                }
                if (reasonSet) break;
            }
            await new Promise(r => setTimeout(r, 80));
            let autoFillForms = getActiveTicketForms('section.grid-ticket-fields-panel', true, 2000);
            if (autoFillForms.length === 0) { for (const sel of ['section[class*="ticket-fields"]', '[data-test-id*="TicketFieldsPane"]', '.ticket_fields', 'form', '[class*="form"]']) { autoFillForms = getActiveTicketForms(sel, false, 1000); if (autoFillForms.length > 0) break; } }
            for (let i = 0; i < autoFillForms.length; i++) { try { await processRumiAutofill(autoFillForms[i], '', true); if (i < autoFillForms.length - 1) await new Promise(r => setTimeout(r, 100)); } catch (e) { console.warn('⚠️ RUMI Safety: processRumiAutofill error:', e); } }
        })();

        // Branch 2: Fetch ticket data
        let customerWords = '';
        let ticketData = null;
        const ticketFetchPromise = (async () => {
            if (!ticketId) return;
            try {
                const resp = await fetch(
                    `https://gocareem.zendesk.com/api/v2/tickets/${ticketId}.json`,
                    { credentials: 'same-origin' }
                );
                if (resp.ok) {
                    const data = await resp.json();
                    ticketData = data.ticket;

                    const hasVoiceCareTagFlag = ticketData.tags && ticketData.tags.includes('ssoc_voice_created_ticket');
                    const hasExcludeTagFlag = ticketData.tags && ticketData.tags.includes('exclude_detection');

                    if (hasExcludeTagFlag) {
                        // ── SOCIAL MEDIA ticket ──────────────────────────────────
                        // Use conversations API, extract "Issue raised" field
                        const convResp = await fetch(
                            `https://gocareem.zendesk.com/api/lotus/tickets/${ticketId}/conversations.json`,
                            { credentials: 'include', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' } }
                        );
                        if (convResp.ok) {
                            const convData = await convResp.json();
                            const conversations = convData.conversations || [];
                            if (conversations.length > 0) {
                                const firstBody = conversations[0].plain_body || '';
                                customerWords = extractSocialMediaIssueRaised(firstBody);
                            }
                        }
                        // Fallback to ticket description if extraction failed
                        if (!customerWords) {
                            customerWords = extractSocialMediaIssueRaised(ticketData.description || '');
                        }

                    } else if (hasVoiceCareTagFlag) {
                        // ── VOICE CARE ticket ────────────────────────────────────
                        const description = ticketData.description || '';
                        const detailedDesc = extractDescription(description);
                        customerWords = detailedDesc || description.trim();

                    } else {
                        // ── NORMAL ticket ────────────────────────────────────────
                        customerWords = await fetchCustomerWordsFromConversations(ticketId);
                        if (!customerWords) {
                            const description = ticketData.description || '';
                            customerWords = extractDescription(description) || description.trim();
                        }
                    }
                }
            } catch (err) {
                console.warn('⚠️ RUMI Safety: Error fetching ticket data:', err);
            }
        })();
        
        await Promise.all([formFillPromise, ticketFetchPromise]);
        const city = await awaitPrefetchedCity(ticketId);
        const detectedLang = detectLanguage(customerWords, city || '') || 'English';
        
        let langForms = getActiveTicketForms('section.grid-ticket-fields-panel', true, 2000);
        if (langForms.length === 0) {
            for (const sel of ['section[class*="ticket-fields"]', '[data-test-id*="TicketFieldsPane"]']) {
                langForms = getActiveTicketForms(sel, false, 1000);
                if (langForms.length > 0) break;
            }
        }
        for (const form of langForms) { await setLanguageField(form, detectedLang); }
        
        let targetUrl = '';
        if (ticketData) targetUrl = await buildApolloUrl(ticketData);
        if (!targetUrl) targetUrl = `https://apollo.careempartner.com/uber/issue-selection?sourceInteractionId=${ticketId || ''}`;
        openBackgroundTab(targetUrl);
        
        try {
            const templateText = await generateDynamicTemplateText(customerWords, detectedLang, reasonValue);
            await navigator.clipboard.writeText(templateText);
        } catch (err) { console.error('⚠️ RUMI Safety: Failed to generate/copy template:', err); }
        
        await assignmentPromise;
    }
        
    function _getCurrentTicketId() { const match = window.location.pathname.match(/\/agent\/tickets\/(\d+)/); return match ? match[1] : null; }

    function _findComposerPane() {
        const currentTicketId = _getCurrentTicketId();
        const switchers = document.querySelectorAll('button[data-test-id="omnichannel-channel-switcher-button"]');
        for (const channelSwitcher of switchers) {
            const isVisible = channelSwitcher.isConnected && channelSwitcher.offsetParent !== null;
            const switcherTicketId = channelSwitcher.getAttribute('data-channel-switcher-trigger-for-ticket-id');
            const isRightTicket = !currentTicketId || switcherTicketId === currentTicketId;
            if (isVisible && isRightTicket) {
                let pane = channelSwitcher.closest('[data-test-id="ticket-rich-text-editor"]') || channelSwitcher.closest('[data-test-id="omnichannel-composer-toolbar"]');
                if (!pane) { pane = channelSwitcher.parentElement; for (let i = 0; i < 5 && pane; i++) { if (pane.querySelector('[data-garden-id="typography.font"]') || pane.querySelector('[role="textbox"]')) return pane; pane = pane.parentElement; } }
                if (pane && pane.isConnected) return pane;
            }
        }
        for (const sel of ['[data-test-id="ticket-rich-text-editor"]', '[data-test-id="omnichannel-composer-toolbar"]']) {
            const matches = document.querySelectorAll(sel);
            for (const el of matches) {
                if (el.isConnected && el.offsetParent !== null) {
                    if (currentTicketId) { const innerSwitcher = el.querySelector('button[data-test-id="omnichannel-channel-switcher-button"]'); if (innerSwitcher) { const innerId = innerSwitcher.getAttribute('data-channel-switcher-trigger-for-ticket-id'); if (innerId && innerId !== currentTicketId) continue; } }
                    return el;
                }
            }
        }
        for (const sel of ['[data-test-id="ticket-rich-text-editor"]', '[data-test-id="omnichannel-composer-toolbar"]']) { const el = document.querySelector(sel); if (el && el.isConnected) return el; }
        return null;
    }

    let _lastSeenTicketId = null;
    let _safetyButtonsRetryTimer = null;

    function cancelSafetyButtonsRetry() { if (_safetyButtonsRetryTimer !== null) { clearTimeout(_safetyButtonsRetryTimer); _safetyButtonsRetryTimer = null; } }

    function tryInsertRUMISafetyButtons(attempts = 0) {
        if (!isTicketView()) { cancelSafetyButtonsRetry(); const stale = document.getElementById('rumi-safety-buttons-container'); if (stale) stale.remove(); return; }
        const maxAttempts = 20;
        const currentTicketId = _getCurrentTicketId();
        let existing = document.getElementById('rumi-safety-buttons-container');
        if (attempts === 0 && currentTicketId && currentTicketId !== _lastSeenTicketId) { _lastSeenTicketId = currentTicketId; cancelSafetyButtonsRetry(); if (existing) { existing.remove(); existing = null; } _safetyButtonsRetryTimer = setTimeout(() => tryInsertRUMISafetyButtons(1), 500); return; }

        if (existing && !existing.isConnected) existing.remove();
        if (insertRUMISafetyButtons()) return;

        if (attempts < maxAttempts) _safetyButtonsRetryTimer = setTimeout(() => tryInsertRUMISafetyButtons(attempts + 1), 300);
        else console.warn('⚠️ RUMI Safety: Could not inject buttons after ' + maxAttempts + ' attempts');
    }

    function insertRUMISafetyButtons() {
        const existingContainer = document.getElementById('rumi-safety-buttons-container');
        const composerPane = _findComposerPane();
        if (existingContainer && composerPane && composerPane.contains(existingContainer)) return true;
        if (existingContainer) existingContainer.remove();
        if (!composerPane) return false;
        const container = document.createElement('div');
        container.id = 'rumi-safety-buttons-container';
        RUMI_SAFETY_BUTTONS.forEach(({ label, reason, dropdownValue }) => {
            const btn = document.createElement('span');
            btn.setAttribute('role', 'button'); btn.setAttribute('tabindex', '0'); btn.setAttribute('aria-pressed', 'false'); btn.setAttribute('aria-label', label); btn.setAttribute('title', reason); btn.setAttribute('data-rumi-safety-reason', reason);
            btn.className = 'ember-view btn rumi-safety-btn'; btn.textContent = label; btn._dropdownValue = dropdownValue || reason;
            const clickHandler = (e) => { e.preventDefault(); e.stopPropagation(); handleSafetyButtonClick(reason, btn); };
            btn.addEventListener('click', clickHandler);
            btn.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') clickHandler(e); });
            container.appendChild(btn);
        });
        const toolbar = composerPane.querySelector('[data-test-id="omnichannel-composer-toolbar"]');
        if (toolbar) toolbar.appendChild(container);
        else composerPane.appendChild(container);
        console.log('✅ RUMI Safety: 11 safety buttons injected inside composer toolbar');
        return true;
    }

    function isTicketView() { return window.location.pathname.includes('/agent/tickets/'); }

    let handleTicketViewTimeout = null;
    let isHandlingTicketView = false;

    function handleTicketView() {
        if (!isTicketView() || observerDisconnected || isHandlingTicketView) return;
        if (handleTicketViewTimeout) clearTimeout(handleTicketViewTimeout);
        handleTicketViewTimeout = setTimeout(() => {
            isHandlingTicketView = true;
            // ✅ fire and forget, zero blocking
            prefetchCityForTicket(getCurrentTicketId());
            tryAddToggleButton();
            tryInsertApolloButton();
            tryInsertRumiButton();
            tryAttachPQMSToZendeskIcon();
            insertNotSafetyRelatedButton();
            tryInsertRUMISafetyButtons();
            setTimeout(() => { applyFieldVisibilityState(); setTimeout(() => { isHandlingTicketView = false; }, 300); }, 100);
        }, 500);
    }

    function handleRUMIEnhancementInit() { return; }

    let viewsAreHidden = false;
    const essentialViews = ['SSOC - Open - Urgent', 'SSOC - GCC & EM Open', 'SSOC - Egypt Urgent', 'SSOC - Egypt Open', 'SSOC_JOD_from ZD only', 'Community Escalation - SAFETY ISSUE (Other than PAK)', 'Community Escalation - SAFETY ISSUE (RH - EGY)'];

    function createViewsToggleButton() {
        const viewsHeader = document.querySelector('[data-test-id="views_views-list_header"] h3');
        if (!viewsHeader) return false;
        if (viewsHeader.querySelector('#views-toggle-wrapper')) return true;
        const originalText = viewsHeader.textContent.trim();
        viewsHeader.innerHTML = '';
        const clickableWrapper = document.createElement('span');
        clickableWrapper.id = 'views-toggle-wrapper'; clickableWrapper.setAttribute('data-views-toggle', 'true'); clickableWrapper.setAttribute('role', 'button'); clickableWrapper.setAttribute('tabindex', '0'); clickableWrapper.title = 'Click to hide/show non-essential views';
        clickableWrapper.style.cssText = `cursor: pointer !important; user-select: none !important; transition: all 0.2s ease !important; padding: 2px 6px !important; border-radius: 4px !important; display: inline-block !important; background: transparent !important; border: none !important; font: inherit !important; color: inherit !important;`;
        const textSpan = document.createElement('span'); textSpan.textContent = originalText; clickableWrapper.appendChild(textSpan); viewsHeader.appendChild(clickableWrapper);
        clickableWrapper.addEventListener('mouseenter', (e) => { e.stopPropagation(); clickableWrapper.style.backgroundColor = '#f8f9fa'; });
        clickableWrapper.addEventListener('mouseleave', (e) => { e.stopPropagation(); clickableWrapper.style.backgroundColor = 'transparent'; });
        let isClicking = false;
        const handleClick = (e) => {
            e.preventDefault(); e.stopPropagation();
            if (isClicking) return;
            isClicking = true; clickableWrapper.style.opacity = '0.8';
            try { toggleNonEssentialViews(); } catch (error) { console.error('❌ Error in toggle function:', error); }
            setTimeout(() => { clickableWrapper.style.opacity = '1'; isClicking = false; }, 300);
        };
        clickableWrapper.addEventListener('click', handleClick);
        clickableWrapper.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handleClick(e); } });
        setupRefreshButtonMonitoring();
        return true;
    }

    function setupRefreshButtonMonitoring() {
        const refreshButton = document.querySelector('[data-test-id="views_views-list_header-refresh"]');
        if (refreshButton) { refreshButton.addEventListener('click', () => { if (viewsAreHidden) setTimeout(() => { if (viewsAreHidden) hideNonEssentialViews(); }, 1000); }); }
        else setTimeout(setupRefreshButtonMonitoring, 1000);
    }

    function toggleNonEssentialViews() {
        viewsAreHidden = !viewsAreHidden;
        const toggleWrapper = document.getElementById('views-toggle-wrapper');
        if (viewsAreHidden) { if (toggleWrapper) toggleWrapper.title = 'Click to show all views'; hideNonEssentialViews(); }
        else { if (toggleWrapper) toggleWrapper.title = 'Click to hide non-essential views'; showAllViews(); }
        localStorage.setItem('viewsAreHidden', viewsAreHidden.toString());
    }

    function hideNonEssentialViews() {
        const viewItems = document.querySelectorAll('[data-test-id*="views_views-list_item"]:not([data-test-id*="tooltip"])');
        if (viewItems.length === 0) return;
        let hiddenCount = 0; let keptCount = 0;
        const processedItems = new Set();
        viewItems.forEach(item => {
            if (item.getAttribute('aria-label') === 'Refresh views pane' || item.id === 'views-toggle-button' || item.getAttribute('data-views-toggle') === 'true' || item.className?.includes('views-toggle-btn') || processedItems.has(item)) return;
            let viewName = '';
            const titleElement = item.querySelector('[data-garden-id="typography.ellipsis"]') || item.querySelector('.StyledEllipsis-sc-1u4umy-0') || item.querySelector('span[title]') || item.querySelector('span:not([class*="count"]):not([class*="number"])');
            if (titleElement) viewName = titleElement.getAttribute('title')?.trim() || titleElement.textContent?.trim() || '';
            if (!viewName) viewName = (item.textContent?.trim() || '').replace(/\d+(?:\.\d+)?[KMB]?$/, '').trim();
            if (!viewName || viewName.length < 3 || viewName.toLowerCase().includes('refresh') || /^\d+$/.test(viewName) || viewName === 'Views') return;
            processedItems.add(item);
            if (!essentialViews.includes(viewName)) { item.classList.add('hidden-view-item'); item.setAttribute('data-hidden-by-toggle', 'true'); item.setAttribute('data-view-name', viewName); hiddenCount++; }
            else { item.classList.remove('hidden-view-item'); item.removeAttribute('data-hidden-by-toggle'); keptCount++; }
        });
        console.log(`🔍 Non-essential views hidden: ${hiddenCount} hidden, ${keptCount} kept visible`);
        setupViewsObserver();
    }

    function showAllViews() {
        const hiddenItems = document.querySelectorAll('[data-hidden-by-toggle="true"]');
        hiddenItems.forEach(item => { item.classList.remove('hidden-view-item'); item.removeAttribute('data-hidden-by-toggle'); });
        if (window.viewsObserver) { window.viewsObserver.disconnect(); window.viewsObserver = null; }
    }

    function setupViewsObserver() {
        if (window.viewsObserver) window.viewsObserver.disconnect();
        let isReapplying = false;
        window.viewsObserver = new MutationObserver((mutations) => {
            if (!viewsAreHidden || isReapplying) return;
            let needsReapply = false; let refreshDetected = false;
            mutations.forEach(mutation => {
                if (mutation.target.id === 'views-toggle-button' || mutation.target.id === 'views-toggle-wrapper' || mutation.target.id === 'views-header-left-container' || mutation.target.getAttribute('data-views-toggle') === 'true' || mutation.target.className?.includes('views-toggle-btn')) return;
                if (mutation.type === 'childList' && mutation.addedNodes.length > 0) { mutation.addedNodes.forEach(node => { if (node.nodeType === 1) { if ((node.matches && node.matches('[data-test-id*="views_views-list_item"]')) || (node.querySelector && node.querySelector('[data-test-id*="views_views-list_item"]'))) refreshDetected = true; } }); }
                if (mutation.target.hasAttribute && mutation.target.hasAttribute('data-hidden-by-toggle') && mutation.type === 'attributes' && (mutation.attributeName === 'style' || mutation.attributeName === 'class') && !mutation.target.classList.contains('hidden-view-item')) needsReapply = true;
            });
            if (refreshDetected || needsReapply) { isReapplying = true; setTimeout(() => { if (viewsAreHidden) hideNonEssentialViews(); isReapplying = false; }, 500); }
        });
        const viewsContainer = document.querySelector('[data-test-id="views_views-pane_content"]');
        if (viewsContainer) window.viewsObserver.observe(viewsContainer, { childList: true, subtree: true, attributes: true, attributeFilter: ['style', 'class'] });
        const hiddenItems = document.querySelectorAll('[data-hidden-by-toggle="true"]');
        hiddenItems.forEach(item => { window.viewsObserver.observe(item, { attributes: true, attributeFilter: ['style', 'class'] }); });
    }

    function loadViewsToggleState() {
        const saved = localStorage.getItem('viewsAreHidden');
        if (saved === 'true') { viewsAreHidden = true; setTimeout(() => { const toggleWrapper = document.getElementById('views-toggle-wrapper'); if (toggleWrapper) { toggleWrapper.title = 'Click to show all views'; hideNonEssentialViews(); } }, 500); }
    }

    function isViewsPage() { return window.location.pathname.includes('/agent/filters/') || document.querySelector('[data-test-id="views_views-pane-div"]'); }

    // ========================================
    // Apollo Button Functions
    // ========================================

    const apolloButtonState = {
        currentTicketId: null,
        urlCheckInterval: null,
        cachedUrls: new Map()
    };

    async function fetchTicketDataForApollo(ticketId) {
        try {
            const response = await RUMIAPIManager.makeRequest(`/api/v2/tickets/${ticketId}.json`);
            if (response && response.ticket) return response.ticket;
            return null;
        } catch (error) { RUMILogger.error('APOLLO', `Failed to fetch ticket data: ${error.message}`, ticketId); return null; }
    }

    function getCustomFieldValue(ticket, fieldId) { if (!ticket || !ticket.custom_fields) return null; const field = ticket.custom_fields.find(f => f.id === parseInt(fieldId)); return field ? field.value : null; }

    async function getGroupNameFromTicket(ticket) {
        if (!ticket || !ticket.group_id) return '';
        try { const response = await RUMIAPIManager.makeRequest(`/api/v2/groups/${ticket.group_id}.json`); if (response && response.group && response.group.name) return response.group.name; }
        catch (error) { console.log('APOLLO', `Failed to fetch group name: ${error.message}`); }
        return ticket.group_id.toString();
    }

    async function getRequesterDetails(ticket) {
        if (!ticket || !ticket.requester_id) return { email: '', phone: '' };
        try { const response = await RUMIAPIManager.makeRequest(`/api/v2/users/${ticket.requester_id}.json`); if (response && response.user) return { email: response.user.email || '', phone: response.user.phone || '' }; }
        catch (error) { console.log('APOLLO', `Failed to fetch requester details: ${error.message}`); }
        return { email: '', phone: '' };
    }

    function convertDateTimeToEpoch(dateTime) { return Math.floor(new Date(dateTime).getTime() / 1000); }

    function encodeUuidToCustomBase64(uuid) {
        const prefix = new Uint8Array([0x10, 0, 0, 0, 0, 0, 0, 0, 0x01]);
        const uuidBytes = new TextEncoder().encode(uuid);
        const combined = new Uint8Array(prefix.length + uuidBytes.length);
        combined.set(prefix); combined.set(uuidBytes, prefix.length);
        let binary = ''; combined.forEach(byte => binary += String.fromCharCode(byte));
        return btoa(binary);
    }

    function parseSsocVoiceComment(commentBody) {
        if (!commentBody) return { phoneNumber: null, tripId: null };
        const commentBodyLower = commentBody.toLowerCase();
        const uuidRegex = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/;
        const phone12Regex = /\d{12}/; const phone11KwtRegex = /\b965\d{8}\b/;
        let phoneNumber = null; let tripId = null;
        let phoneMatch = commentBody.match(phone12Regex);
        if (!phoneMatch) phoneMatch = commentBody.match(phone11KwtRegex);
        if (phoneMatch) phoneNumber = phoneMatch[0];
        const uuidMatch = commentBodyLower.match(uuidRegex);
        if (uuidMatch) tripId = uuidMatch[0];
        return { phoneNumber, tripId };
    }

    async function buildApolloUrl(ticketData) {
        if (!ticketData) return null;
        const urlParts = [];
        urlParts.push(`sourceInteractionId=${ticketData.id}`);
        const hasSsocVoiceTag = ticketData.tags && ticketData.tags.includes('ssoc_voice_created_ticket');
        const hasExcludeDetectionTagFlag = ticketData.tags && ticketData.tags.includes('exclude_detection');
        let activityId = ''; let phoneNumber = '';
        if (hasExcludeDetectionTagFlag) {
            const phone12Regex = /(?<=\D)\d{12}(?=\D)/; const phone11KwtRegex = /(?<=\D)965\d{8}(?=\D)/;
            let phoneMatch = ticketData.subject.match(phone12Regex);
            if (!phoneMatch) phoneMatch = ticketData.subject.match(phone11KwtRegex);
            if (phoneMatch) phoneNumber = phoneMatch[0];
            activityId = getCustomFieldValue(ticketData, '15220303991955') || '';
        } else if (hasSsocVoiceTag) {
            try {
                const comments = await fetchTicketComments(ticketData.id);
                if (comments && comments.length > 0) {
                    const { phoneNumber: extractedPhone, tripId } = parseSsocVoiceComment(comments[0].body);
                    if (extractedPhone) phoneNumber = extractedPhone;
                    if (tripId) activityId = encodeUuidToCustomBase64(tripId);
                }
            } catch (error) { console.warn('Failed to get ticket comments for ssoc_voice_created_ticket:', error); }
        }
        if (!activityId) {
            const rawFieldValue = getCustomFieldValue(ticketData, '15220303991955') || '';
            const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
            activityId = uuidRegex.test(rawFieldValue) ? encodeUuidToCustomBase64(rawFieldValue) : rawFieldValue;
        }
        urlParts.push(`activityId=${activityId}`);
        const groupName = await getGroupNameFromTicket(ticketData);
        urlParts.push(`zendeskQueueName=${groupName ? groupName.replace(/ /g, '%20').replace(/&/g, '&') : ''}`);
        const requesterDetails = await getRequesterDetails(ticketData);
        urlParts.push(`email=${requesterDetails.email || ''}`);
        urlParts.push('channel=2'); urlParts.push('source=2'); urlParts.push('queueName=uber');
        if (!phoneNumber) phoneNumber = getCustomFieldValue(ticketData, '47477248') || '';
        urlParts.push(`phoneNumber=${phoneNumber}`);
        urlParts.push(`phoneNumber2=${requesterDetails.phone || ''}`);
        const threadId = getCustomFieldValue(ticketData, '23786173');
        urlParts.push(`threadId=${threadId || ''}`);
        if (ticketData.created_at) urlParts.push(`sourceTime=${convertDateTimeToEpoch(ticketData.created_at)}`);
        else urlParts.push(`sourceTime=`);
        return `https://apollo.careempartner.com/uber/issue-selection?${urlParts.join('&')}`;
    }

    function getTicketIdFromUrl() { const match = window.location.pathname.match(/\/agent\/tickets\/(\d+)/); return match ? match[1] : null; }

    async function prefetchApolloUrl(ticketId) {
        if (apolloButtonState.cachedUrls.has(ticketId)) return;
        console.log(`⚡ APOLLO: Pre-fetching data for ticket ${ticketId}`);
        try {
            const ticketData = await fetchTicketDataForApollo(ticketId);
            if (ticketData) { const apolloUrl = await buildApolloUrl(ticketData); if (apolloUrl) apolloButtonState.cachedUrls.set(ticketId, apolloUrl); }
        } catch (error) { console.warn(`⚠️ APOLLO: Failed to pre-fetch for ticket ${ticketId}:`, error); }
    }

    function checkAndUpdateApolloButton() {
        const currentTicketId = getTicketIdFromUrl();
        if (!currentTicketId) return;
        if (currentTicketId !== apolloButtonState.currentTicketId) { apolloButtonState.currentTicketId = currentTicketId; insertApolloButton(); prefetchApolloUrl(currentTicketId); }
    }

    function startApolloUrlMonitoring() { if (!apolloButtonState.urlCheckInterval) { apolloButtonState.urlCheckInterval = setInterval(checkAndUpdateApolloButton, 500); console.log('✅ APOLLO: Started URL monitoring'); } }
    function stopApolloUrlMonitoring() { if (apolloButtonState.urlCheckInterval) { clearInterval(apolloButtonState.urlCheckInterval); apolloButtonState.urlCheckInterval = null; } }

    function createApolloButton() {
        const apolloButton = document.createElement('li');
        apolloButton.className = 'sc-1xt32ep-0 fZnAAO'; apolloButton.setAttribute('tabindex', '-1'); apolloButton.setAttribute('data-apollo-button', 'true');
        apolloButton.innerHTML = `<button aria-pressed="false" aria-label="Open in Apollo" class="StyledButton-sc-qe3ace-0 StyledIconButton-sc-1t0ughp-0 eUFUgT iQoDao sc-2ax5cx-0 hmFTsS" data-garden-id="buttons.icon_button" data-garden-version="9.11.3" type="button" style="position: relative;"><svg id="Layer_1" data-name="Layer 1" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96" width="16" height="16" aria-hidden="true" focusable="false" data-garden-id="buttons.icon" data-garden-version="9.11.3" class="StyledBaseIcon-sc-1moykgb-0 StyledIcon-sc-19meqgg-0 eWlVPJ cxMMcO"><defs><style>.cls-1{fill-rule:evenodd;}.cls-2{fill:#fff;}</style></defs><path class="cls-1" d="M7.27,0H88.73A7.28,7.28,0,0,1,96,7.27V88.73A7.28,7.28,0,0,1,88.73,96H7.27A7.28,7.28,0,0,1,0,88.73V7.27A7.28,7.28,0,0,1,7.27,0Z"/><path class="cls-2" d="M18.8,52.91A5.61,5.61,0,0,0,20,54.81,5,5,0,0,0,21.71,56a5.71,5.71,0,0,0,2.2.42,5.34,5.34,0,0,0,3.95-1.66A5.54,5.54,0,0,0,29,52.89a6.75,6.75,0,0,0,.42-2.44V36.54h3.38V59.07H29.48V57a7.77,7.77,0,0,1-2.65,1.83,8.41,8.41,0,0,1-3.3.65,8.89,8.89,0,0,1-3.36-.63A8,8,0,0,1,17.46,57a8.44,8.44,0,0,1-1.8-2.78A9.53,9.53,0,0,1,15,50.64V36.54h3.38V50.45a6.9,6.9,0,0,0,.42,2.46ZM77,46.68a4.34,4.34,0,0,0-1,3.06v9.33H72.73V42.66H76v2a4.54,4.54,0,0,1,1.59-1.58,4.45,4.45,0,0,1,2.33-.58H81v3H79.65A3.42,3.42,0,0,0,77,46.68Zm-22.08.9a8.87,8.87,0,0,1,1.77-2.72A8.29,8.29,0,0,1,59.38,43,8.69,8.69,0,0,1,66,43a7.69,7.69,0,0,1,2.61,1.79,8.18,8.18,0,0,1,1.71,2.7,9.37,9.37,0,0,1,.61,3.39v1.07H57.57a5.44,5.44,0,0,0,.65,1.85,5.74,5.74,0,0,0,1.2,1.48,5.9,5.9,0,0,0,1.64,1,5.52,5.52,0,0,0,1.95.35,5.62,5.62,0,0,0,4.73-2.41l2.35,1.74A8.55,8.55,0,0,1,63,59.42a9.1,9.1,0,0,1-3.43-.64A8.38,8.38,0,0,1,55,54.26a8.46,8.46,0,0,1-.68-3.4,8.63,8.63,0,0,1,.64-3.28Zm4.53-1.27a5.45,5.45,0,0,0-1.82,3h10a5.29,5.29,0,0,0-1.78-3,5.06,5.06,0,0,0-6.4,0ZM38.65,36.54v8.21A8.6,8.6,0,0,1,41.26,43a7.83,7.83,0,0,1,3.22-.66,8.65,8.65,0,0,1,6.11,2.51,8.77,8.77,0,0,1,1.83,2.74,8.26,8.26,0,0,1,.68,3.35,8.13,8.13,0,0,1-.68,3.33A8.8,8.8,0,0,1,50.59,57a8.65,8.65,0,0,1-6.11,2.51,8,8,0,0,1-3.24-.66A8.65,8.65,0,0,1,38.62,57v2.06H35.4V36.54ZM39,53.12a5.65,5.65,0,0,0,1.21,1.8A5.79,5.79,0,0,0,42,56.14a5.51,5.51,0,0,0,2.22.45,5.43,5.43,0,0,0,2.19-.45,5.74,5.74,0,0,0,1.79-1.22,6.16,6.16,0,0,0,1.2-1.8,5.51,5.51,0,0,0,.45-2.22,5.6,5.6,0,0,0-.45-2.24,6,6,0,0,0-1.2-1.82,5.55,5.55,0,0,0-1.79-1.21,5.64,5.64,0,0,0-6.18,1.21A5.88,5.88,0,0,0,39,48.66a5.6,5.6,0,0,0-.45,2.24A5.67,5.67,0,0,0,39,53.12Z"/></svg></button>`;

        const button = apolloButton.querySelector('button');
        button.addEventListener('click', async () => {
            const ticketId = getTicketIdFromUrl();
            if (!ticketId) { console.warn('⚠️ APOLLO: No ticket ID in URL'); return; }

            // Try to use cached URL first for instant navigation
            // Try cached URL first
            let apolloUrl = apolloButtonState.cachedUrls.get(ticketId);

            if (apolloUrl) {
                // Cache hit — open immediately
                openForegroundTab(apolloUrl);
                console.log(`⚡ APOLLO: Opened cached URL in foreground for ticket ${ticketId}`);
                return;
            }

            // Cache miss — fetch on demand
            console.log(`🔗 APOLLO: Cache miss, fetching data for ticket ${ticketId}`);
            const ticketData = await fetchTicketDataForApollo(ticketId);
            if (!ticketData) {
                console.warn('⚠️ APOLLO: Failed to fetch ticket data');
                return;
            }
            apolloUrl = await buildApolloUrl(ticketData);
            if (!apolloUrl) {
                console.warn('⚠️ APOLLO: Failed to build Apollo URL');
                return;
            }
            apolloButtonState.cachedUrls.set(ticketId, apolloUrl);
            openForegroundTab(apolloUrl);
            console.log(`✅ APOLLO: Opened for ticket ${ticketId}`);
        });

        apolloButtonState.buttonElement = apolloButton;
        return apolloButton;
    }

    function insertApolloButton() {
        const currentTicketId = getTicketIdFromUrl();
        if (!currentTicketId) return false;
        const omnipanelLists = document.querySelectorAll('ul.sc-1vuz3kl-1.iUAIrg');
        if (omnipanelLists.length === 0) return false;
        let inserted = false;
        omnipanelLists.forEach((omnipanelList) => {
            const style = window.getComputedStyle(omnipanelList);
            if (style.display === 'none' || style.visibility === 'hidden') return;
            const existingButton = omnipanelList.querySelector('[data-apollo-button="true"]');
            if (existingButton) { if (existingButton.getAttribute('data-ticket-id') === currentTicketId) { inserted = true; return; } else existingButton.remove(); }
            const appsButton = omnipanelList.querySelector('[data-test-id="omnipanel-selector-item-apps"]');
            if (!appsButton) return;
            const apolloButton = createApolloButton();
            apolloButton.setAttribute('data-ticket-id', currentTicketId);
            const appsLi = appsButton.closest('li');
            if (appsLi && appsLi.parentNode) { appsLi.parentNode.insertBefore(apolloButton, appsLi.nextSibling); console.log(`✅ APOLLO: Button inserted for ticket ${currentTicketId}`); inserted = true; }
        });
        return inserted;
    }

    function tryInsertApolloButton(attempts = 0) {
        const maxAttempts = 10;
        if (insertApolloButton()) {
            const ticketId = getTicketIdFromUrl();
            if (ticketId) { apolloButtonState.currentTicketId = ticketId; prefetchApolloUrl(ticketId); startApolloUrlMonitoring(); }
            return;
        }
        if (attempts < maxAttempts) setTimeout(() => tryInsertApolloButton(attempts + 1), 500);
    }

    // ========================================
    // RUMI Button + Duplicate Button Injection
    // ========================================

    /**
     * Inject RUMI and Duplicate buttons into the active composer toolbar.
     * Copied from Reference.js insertRumiButton() — uses [data-test-id="ticket-editor-app-icon-view"]
     * as the toolbar container, then finds the link button wrapper as insertion anchor.
     */
    function insertRumiButton() {
        const currentTicketId = getTicketIdFromUrl();
        if (!currentTicketId) return false;

        // Remove stale buttons from a different ticket
        document.querySelectorAll('[data-rumi-inject-button]').forEach(el => {
            if (el.getAttribute('data-ticket-id') !== currentTicketId) el.remove();
        });

        // Find all visible editor toolbars
        const toolbars = Array.from(
            document.querySelectorAll('[data-test-id="ticket-editor-app-icon-view"]')
        ).filter(el => el.isConnected && el.offsetParent !== null);

        if (toolbars.length === 0) {
            console.log('⏳ RUMI: toolbar not found yet, will retry');
            return false;
        }

        let inserted = false;

        toolbars.forEach(toolbar => {
            // Skip if already injected for this ticket
            if (toolbar.querySelector(`[data-rumi-inject-button][data-ticket-id="${currentTicketId}"]`)) {
                inserted = true;
                return;
            }

            // Find the link button as anchor
            const originalLinkButton = toolbar.querySelector('[data-test-id="ticket-composer-toolbar-link-button"]');
            if (!originalLinkButton) return;

            const originalWrapper = originalLinkButton.parentElement;
            if (!originalWrapper) return;

            let insertAfter = originalWrapper;

            // Create and insert RUMI button
            const existingRumi = toolbar.querySelector('[data-test-id="rumi-button"]');
            if (!existingRumi) {
                const rumiWrapper = createRumiButton();
                rumiWrapper.setAttribute('data-rumi-inject-button', 'rumi');
                rumiWrapper.setAttribute('data-ticket-id', currentTicketId);
                originalWrapper.parentNode.insertBefore(rumiWrapper, insertAfter.nextSibling);
                insertAfter = rumiWrapper;
            } else {
                insertAfter = existingRumi.closest('[data-rumi-inject-button]') || existingRumi.parentElement || insertAfter;
            }

            // Create and insert Duplicate button
            const existingDup = toolbar.querySelector('[data-test-id="duplicate-button"]');
            if (!existingDup) {
                const dupWrapper = createDuplicateButton();
                dupWrapper.setAttribute('data-rumi-inject-button', 'duplicate');
                dupWrapper.setAttribute('data-ticket-id', currentTicketId);
                originalWrapper.parentNode.insertBefore(dupWrapper, insertAfter.nextSibling);
            }

            console.log(`✅ RUMI: RUMI + Duplicate buttons injected for ticket ${currentTicketId}`);
            inserted = true;
        });

        return inserted;
    }

    function tryInsertRumiButton(attempts = 0) {
        const maxAttempts = 20;
        if (insertRumiButton()) return;
        if (attempts < maxAttempts) setTimeout(() => tryInsertRumiButton(attempts + 1), 400);
        else console.warn('⚠️ RUMI: Could not inject RUMI/Duplicate buttons after max attempts');
    }

    let handleViewsPageTimeout = null;
    function handleViewsPage() {
        if (isTicketView()) return;
        if (!isViewsPage()) return;
        cancelSafetyButtonsRetry();
        const safetyContainer = document.getElementById('rumi-safety-buttons-container');
        if (safetyContainer) { safetyContainer.remove(); }
        if (document.getElementById('views-toggle-wrapper')) return;
        if (handleViewsPageTimeout) clearTimeout(handleViewsPageTimeout);
        handleViewsPageTimeout = setTimeout(() => {
            if (!document.getElementById('views-toggle-wrapper')) {
                createViewsToggleButton();
                loadViewsToggleState();
            }
        }, 500);
    }

    function init() {
        console.log('🚀 RUMI script initializing...');
        if (window.location.href.includes('/agent/tickets/111111110')) {
            console.log('🛑 RUMI Zendesk: Skipping - this is the RUMI Automation dashboard page.');
            return;
        }
        injectCSS();
        getUsernameFromAPI();
        loadFieldVisibilityState();
        let observerDebounceTimeout = null;
        const observer = new MutationObserver(() => {
            if (observerDebounceTimeout) clearTimeout(observerDebounceTimeout);
            observerDebounceTimeout = setTimeout(() => {
                handleTicketView();
                handleViewsPage();
                // Re-attach PQMS menu to Zendesk icon in case Zendesk re-rendered the nav
                tryAttachPQMSToZendeskIcon();
            }, 200);
        });
        observer.observe(document.body, { childList: true, subtree: true });
        let currentUrl = window.location.href;
        const urlCheckInterval = setInterval(() => {
            if (window.location.href !== currentUrl) {
                currentUrl = window.location.href;
                if (!isTicketView()) {
                    cancelSafetyButtonsRetry();
                    const safetyContainer = document.getElementById('rumi-safety-buttons-container');
                    if (safetyContainer) { safetyContainer.remove(); }
                    setTimeout(handleViewsPage, 300);
                }
                setTimeout(handleTicketView, 300);
            }
        }, 500);
        if (isTicketView()) {
            setTimeout(() => {
                tryAddToggleButton(); tryInsertApolloButton(); tryInsertRumiButton(); tryAttachPQMSToZendeskIcon(); insertNotSafetyRelatedButton(); tryInsertRUMISafetyButtons();
                setTimeout(() => { applyFieldVisibilityState(); }, 100);
            }, 1000);
        }
        // Always try to attach PQMS to Zendesk icon regardless of page type
        tryAttachPQMSToZendeskIcon();
        if (isViewsPage()) { setTimeout(() => { createViewsToggleButton(); loadViewsToggleState(); }, 1000); }
        document.addEventListener('keydown', (e) => {
            if (e.altKey && !e.ctrlKey && !e.shiftKey) {
                let status = null;
                if (e.key === 'o' || e.key === 'O' || e.key === 'خ') status = 'Open';
                else if (e.key === 'p' || e.key === 'P' || e.key === 'ح') status = 'Pending';
                else if (e.key === 's' || e.key === 'S' || e.key === 'س') status = 'Solved';
                if (status) { e.preventDefault(); e.stopPropagation(); submitToPQMS(status); }
            }
        });
        RUMILogger.info('SYSTEM', 'RUMI Enhancement system initialized');
        console.log('✅ RUMI script initialized');
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();

})();
