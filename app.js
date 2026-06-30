/**
 * =========================================================================
 * GlamTrack Core Platform Controller - Salon Worker Translation Layer
 * Production Engine Build - Synced with Provided Constants & ErrorMailer
 * =========================================================================
 */

import { initializeApp } from "https://www.gstatic.com/firebasejs/9.23.0/firebase-app.js";
import { 
    getFirestore, collection, query, where, getDocs, getDoc, doc, setDoc, onSnapshot, writeBatch, updateDoc, deleteDoc
} from "https://www.gstatic.com/firebasejs/9.23.0/firebase-firestore.js";

// Import your provided modular configurations
import { SAMPLE_CATEGORIES, SAMPLE_SERVICES, SAMPLE_SUB_SERVICES } from "./constants.js";
import { reportRuntimeCrash } from "./errorMailer.js";

// Production Firebase Configuration 
const FIREBASE_CONFIG = {
    apiKey: "AIzaSyDQO_LSnflOgA5H-Nz95eIksx94BhlZP_c",
    authDomain: "vault-050166.firebaseapp.com",
    projectId: "vault-050166",
    storageBucket: "vault-050166.firebasestorage.app",
    messagingSenderId: "252753845895",
    appId: "1:252753845895:web:0def3dc427df7938c12222",
    measurementId: "G-4XEPZ5S45V"
};

// System Execution Runtime States
const firebaseApp = initializeApp(FIREBASE_CONFIG);
const db = getFirestore(firebaseApp);

let activeSessionUser = null;
let salonOwnerNameContext = "Unassigned Salon Context"; 
let realtimePacksUnsubscribe = null;
let sessionWatchdogTimer = null;
let allotCurrentPackTotalAmount = 0;
let allotPacksCache = new Map();
let _utilizeOverrideConfirmed = false;   // tracks negative-balance override consent
let _utilizeOverrideMeta      = null;    // holds override email payload until post-save
let _oldVisitPrevCalcCost     = 0;       // prev calculatedValueCost for old-visit modification
let _oldVisitPrevAddlAmt      = 0;       // prev addlAmtReceived for old-visit modification
let _oldVisitLogDocRef        = null;    // Firestore doc ref of the log being modified
let _utilizeStaffOptions      = null;    // cached [{value, label, userNo, role}] for staff dropdowns
let utilizePrevUnpaidBalance = 0;
const INACTIVITY_TIMEOUT_MS = 15 * 60 * 1000; // 15 Minutes Boundary

// =========================================================================
// Catalog admin helpers (category / service / sub-service edit-delete)
// =========================================================================
function removeCatalogDeleteButton(buttonId) {
    const oldBtn = document.getElementById(buttonId);
    if (oldBtn) oldBtn.remove();
}

function appendCatalogDeleteButton({ formId, buttonId, itemName, targetDocRef, onDeleted, preDeleteConfirm }) {
    const formEl = document.getElementById(formId);
    const saveBtn = formEl.querySelector("button[type='submit']");
    removeCatalogDeleteButton(buttonId);

    const deleteBtn = document.createElement("button");
    deleteBtn.type = "button";
    deleteBtn.id = buttonId;
    deleteBtn.className = "btn btn-danger btn-sm d-block w-100 mt-2 fw-bold";
    deleteBtn.innerText = "🗑️ Delete Item Permanently";
    deleteBtn.addEventListener("click", async () => {
        const proceed = preDeleteConfirm
            ? await preDeleteConfirm()
            : confirm(`Are you absolutely sure you want to permanently delete "${itemName}"? This action cannot be reversed.`);
        if (!proceed) return;
        try {
            await deleteDoc(targetDocRef);
            alert("Success: The item has been completely removed from the menu configuration.");
            onDeleted();
        } catch (delErr) {
            console.error("Deletion process fault trace:", delErr);
            alert("Failed to drop record item from database execution context.");
        }
    });
    saveBtn.parentNode.appendChild(deleteBtn);
}

// Apply background image for pre-login state immediately on load
document.body.classList.add("bg-glamtrack");

async function fetchOwnerRecordByCode(collectionName, codeField, selectedCode) {
    const collRef = collection(db, collectionName);
    let q = query(
        collRef,
        where("ownerUserNo", "==", activeSessionUser.ownerUserNo),
        where(codeField, "==", selectedCode)
    );
    let res = await getDocs(q);
    if (res.empty && !isNaN(selectedCode)) {
        q = query(
            collRef,
            where("ownerUserNo", "==", activeSessionUser.ownerUserNo),
            where(codeField, "==", Number(selectedCode))
        );
        res = await getDocs(q);
    }
    return res.empty ? null : res.docs[0];
}

// =========================================================================
// UI Lifecycle Router Initialization Hook
// =========================================================================
document.addEventListener("DOMContentLoaded", () => {
    initViewRouterLinks();
    setupMediaPreviewListener("pack-promo-file", "preview-pack-img");

    const packSubservicesContainer = document.getElementById("container-pack-subservices");
    if (packSubservicesContainer) {
        packSubservicesContainer.addEventListener("change", (e) => {
            if (e.target.matches(".chk-pack-subservice")) {
                updatePackSubServicesRunningSum();
            }
        });
    }

    // Apply Type3 UI on initial load (Type3 is default)
    applyPackTypeUI(document.getElementById("pack-type-select")?.value || "Type3");

    const packTypeSelect = document.getElementById("pack-type-select");
    if (packTypeSelect) {
        packTypeSelect.addEventListener("change", () => {
            applyPackTypeUI(packTypeSelect.value);
            // Re-run sum to sync pack-total-amt when switching back to Type1/Type2
            updatePackSubServicesRunningSum();
        });
    }

    const packSubSearch = document.getElementById("pack-subservices-search");
    if (packSubSearch) {
        packSubSearch.addEventListener("input", () => {
            const term = packSubSearch.value.toLowerCase().trim();
            document.querySelectorAll("#container-pack-subservices .form-check").forEach(item => {
                const label = item.querySelector("label");
                const text = label ? label.textContent.toLowerCase() : "";
                item.style.display = term === "" || text.includes(term) ? "" : "none";
            });
        });
    }

    const utilizeSubSearch = document.getElementById("utilize-subservices-search");
    if (utilizeSubSearch) {
        utilizeSubSearch.addEventListener("input", () => {
            const term = utilizeSubSearch.value.toLowerCase().trim();
            document.querySelectorAll("#container-utilize-subservices .form-check").forEach(item => {
                const label = item.querySelector("label");
                const text = label ? label.textContent.toLowerCase() : "";
                item.style.display = term === "" || text.includes(term) ? "" : "none";
            });
        });
    }

    const allotCustSearch = document.getElementById("allot-customer-search");
    if (allotCustSearch) {
        allotCustSearch.addEventListener("input", () => {
            const term = allotCustSearch.value.toLowerCase().trim();
            const sel = document.getElementById("allot-customer-select");
            if (!sel || !sel._allOptions) return;
            const prevVal = sel.value;
            sel.innerHTML = "";
            sel._allOptions.forEach(opt => {
                if (term === "" || opt.text.toLowerCase().includes(term)) {
                    sel.appendChild(opt.cloneNode(true));
                }
            });
            if ([...sel.options].some(o => o.value === prevVal)) sel.value = prevVal;
        });
    }

    const utilizeCustSearch = document.getElementById("utilize-customer-search");
    if (utilizeCustSearch) {
        utilizeCustSearch.addEventListener("input", () => {
            const term = utilizeCustSearch.value.toLowerCase().trim();
            const sel = document.getElementById("utilize-customer-select");
            if (!sel || !sel._allOptions) return;
            const prevVal = sel.value;
            sel.innerHTML = "";
            sel._allOptions.forEach(opt => {
                if (term === "" || opt.text.toLowerCase().includes(term)) {
                    sel.appendChild(opt.cloneNode(true));
                }
            });
            if ([...sel.options].some(o => o.value === prevVal)) sel.value = prevVal;
            sel.dispatchEvent(new Event("change"));
        });
    }

    // Generic search filter helper
    function wireDropdownSearch(searchId, selectId, dispatchChange) {
        const si = document.getElementById(searchId);
        if (!si) return;
        si.addEventListener("input", () => {
            const term = si.value.toLowerCase().trim();
            const sel  = document.getElementById(selectId);
            if (!sel || !sel._allOptions) return;
            const pv   = sel.value;
            sel.innerHTML = "";
            sel._allOptions.forEach(o => {
                if (term === "" || o.text.toLowerCase().includes(term)) sel.appendChild(o.cloneNode(true));
            });
            if ([...sel.options].some(o => o.value === pv)) sel.value = pv;
            if (dispatchChange) sel.dispatchEvent(new Event("change"));
        });
    }
    wireDropdownSearch("sub-select-search",      "sub-select-existing",  false);
    wireDropdownSearch("sub-parent-srv-search",  "sub-parent-srv",       false);
    wireDropdownSearch("usr-select-search",      "usr-select-existing",  false);
    wireDropdownSearch("utilize-pack-search",    "utilize-pack-select",  false);
    wireDropdownSearch("allot-pack-search",      "allot-pack-select",    true);
    wireDropdownSearch("pack-select-search",     "pack-select-existing", true);

    const packPriceInput = document.getElementById("pack-price");
    if (packPriceInput) {
        packPriceInput.addEventListener("input", () => {
            const val = parseFloat(packPriceInput.value);
            if (packPriceInput.value !== "" && (isNaN(val) || val <= 0)) packPriceInput.value = "";
            updatePackDiscountDisplay();
        });
    }

    const subRateInput = document.getElementById("sub-rate");
    if (subRateInput) {
        subRateInput.addEventListener("input", () => {
            const val = parseFloat(subRateInput.value);
            if (subRateInput.value !== "" && (isNaN(val) || val <= 0)) subRateInput.value = "";
        });
    }

    const regFeeInput = document.getElementById("usr-reg-fee");
    if (regFeeInput) {
        regFeeInput.addEventListener("input", () => {
            const val = parseFloat(regFeeInput.value);
            if (regFeeInput.value !== "" && (isNaN(val) || val < 0)) regFeeInput.value = "0";
        });
    }

    const utilizeAddlAmtInput = document.getElementById("utilize-addl-amt-received");
    if (utilizeAddlAmtInput) {
        utilizeAddlAmtInput.addEventListener("input", () => {
            const val = parseFloat(utilizeAddlAmtInput.value);
            if (utilizeAddlAmtInput.value !== "" && (isNaN(val) || val < 0)) {
                utilizeAddlAmtInput.value = "0";
            }
            updateUtilizeNewUnpaidDisplay();
        });
    }

    const allotSoldPriceInput = document.getElementById("allot-sold-price");
    if (allotSoldPriceInput) {
        allotSoldPriceInput.addEventListener("input", () => {
            const val = parseFloat(allotSoldPriceInput.value);
            if (allotSoldPriceInput.value !== "" && (isNaN(val) || val <= 0)) {
                allotSoldPriceInput.value = "";
            }
            updateAllotmentDiscountAndBalance();
        });
    }

    const allotAmtReceivedInput = document.getElementById("allot-amount-received");
    if (allotAmtReceivedInput) {
        allotAmtReceivedInput.addEventListener("input", () => {
            const val = parseFloat(allotAmtReceivedInput.value);
            if (allotAmtReceivedInput.value !== "" && (isNaN(val) || val < 0)) {
                allotAmtReceivedInput.value = "0";
            }
            updateAllotmentDiscountAndBalance();
        });
    }
});

function updatePackDiscountDisplay() {
    const priceEl = document.getElementById("pack-price");
    const totalAmtEl = document.getElementById("pack-total-amt");
    const discountEl = document.getElementById("pack-discount-display");
    if (!priceEl || !totalAmtEl || !discountEl) return;

    const price = parseFloat(priceEl.value);
    const totalAmt = parseFloat(totalAmtEl.value);

    if (!isNaN(price) && !isNaN(totalAmt) && totalAmt > 0 && price >= 0) {
        // Point 17: price cannot exceed totalAmt
        if (price > totalAmt) {
            priceEl.value = totalAmt;
            discountEl.textContent = "⚠️ Price cannot exceed Total Amount — reset to match.";
            discountEl.className = "text-danger fw-bold small text-nowrap";
            return;
        }
        const discount = ((totalAmt - price) / totalAmt) * 100;
        if (discount > 0) {
            discountEl.textContent = `${discount.toFixed(1)}% discount`;
            discountEl.className = "text-success fw-bold small text-nowrap";
        } else if (discount < 0) {
            discountEl.textContent = `${Math.abs(discount).toFixed(1)}% above list`;
            discountEl.className = "text-danger fw-bold small text-nowrap";
        } else {
            discountEl.textContent = "No discount";
            discountEl.className = "text-muted fw-bold small text-nowrap";
        }
    } else {
        discountEl.textContent = "";
    }
}

function updatePackSubServicesRunningSum() {
    const sumEl = document.getElementById("pack-subservices-sum");
    if (!sumEl) return;

    const checked = document.querySelectorAll(".chk-pack-subservice:checked");
    let total = 0;
    checked.forEach((input) => {
        total += Number(input.getAttribute("data-rate")) || 0;
    });

    const count = checked.length;
    sumEl.textContent = count === 0
        ? "Selected items total: ₹0"
        : `Selected items total: ₹${total.toLocaleString("en-IN")} (${count} item${count === 1 ? "" : "s"} selected)`;

    // Only auto-update pack-total-amt for Type1/Type2 — Type3 has manual entry
    const packType = document.getElementById("pack-type-select")?.value;
    if (packType !== "Type3") {
        const totalAmtEl = document.getElementById("pack-total-amt");
        if (totalAmtEl) {
            totalAmtEl.value = count === 0 ? "" : total;
            updatePackDiscountDisplay();
        }
    }
}

// ── Dynamic UI for pack type ────────────────────────────────────────────────
function applyPackTypeUI(packType) {
    const totalAmtEl   = document.getElementById("pack-total-amt");
    const totalAmtLbl  = document.getElementById("lbl-pack-total-amt");
    const subLbl       = document.getElementById("lbl-pack-subservices");

    if (packType === "Type3") {
        // Editable total, mandatory, different placeholder
        if (totalAmtEl) {
            totalAmtEl.readOnly = false;
            totalAmtEl.required = true;
            totalAmtEl.placeholder = "Enter Total Price of Services";
        }
        if (totalAmtLbl) totalAmtLbl.textContent = "Total Price of Services (₹)";
        if (subLbl) subLbl.textContent = "Choose Individual Service Items NOT allowed in this Pack";
    } else {
        // Type1 / Type2 — original behaviour
        if (totalAmtEl) {
            totalAmtEl.readOnly = true;
            totalAmtEl.required = false;
            totalAmtEl.placeholder = "Sum of all included individual services";
        }
        if (totalAmtLbl) totalAmtLbl.textContent = "Total Price of Individual Services (₹)";
        if (subLbl) subLbl.textContent = "Choose Individual Service Items Allowed in this Pack";
    }
}

let _galleryTimer = null;
function renderHomePage(role) {
    // Display suppressed — content retained for future use
    return;
    /* eslint-disable no-unreachable */
    const sec = document.getElementById("sec-home");
    if (!sec) return;
    if (_galleryTimer) { clearInterval(_galleryTimer); _galleryTimer = null; }
    if (role === "SUPER_USER" || role === "OWNER") {
        sec.style.backgroundImage = "url('WaterMarkVaultGlamApp.png')";
        sec.style.backgroundSize = "contain";
        sec.style.backgroundRepeat = "no-repeat";
        sec.style.backgroundPosition = "center center";
        sec.style.minHeight = "70vh";
    } else {
        sec.style.backgroundImage = "";
        sec.style.minHeight = "";
    }
    const galleryEl = document.getElementById("home-gallery");
    if (!galleryEl) return;
    if (role !== "OWNER") { galleryEl.style.display = "none"; return; }
    galleryEl.style.display = "block";
    const images = Array.from({length: 8}, (_, i) => `sample_package_${i + 1}.png`);
    const pages  = [images.slice(0, 4), images.slice(4, 8)];
    let pageIdx  = 0;
    const showPage = (idx) => {
        const grid = document.getElementById("home-gallery-grid");
        if (!grid) return;
        grid.innerHTML = "";
        pages[idx].forEach(src => {
            const col = document.createElement("div");
            col.className = "col-6";
            col.innerHTML = `<img src="${src}" alt="" class="img-fluid rounded shadow-sm" style="width:100%;height:200px;object-fit:contain;background:#f8f9fa;">`;
            grid.appendChild(col);
        });
        document.querySelectorAll(".home-gallery-dot").forEach((d, i) => {
            d.classList.toggle("bg-dark",      i === idx);
            d.classList.toggle("bg-secondary", i !== idx);
        });
    }
    showPage(0);
    _galleryTimer = setInterval(() => { pageIdx = (pageIdx + 1) % pages.length; showPage(pageIdx); }, 4000);
    document.querySelectorAll(".home-gallery-dot").forEach((dot, i) => {
        dot.addEventListener("click", () => { pageIdx = i; showPage(pageIdx); });
    });
    /* eslint-enable no-unreachable */
}
function initViewRouterLinks() {
    // GlamTrack brand — show stat-only glamtrack section
    document.getElementById("nav-glamtrack")?.addEventListener("click", async () => {
        // sec-glamtrack is shown only when OWNER is logged in
        if (!activeSessionUser || activeSessionUser.role !== "OWNER") {
            if (!activeSessionUser) showActiveFrame("sec-login");
            return;
        }
        showActiveFrame("sec-glamtrack");
        // Sync the stat count from the live stat-active-packs element
        const src = document.getElementById("stat-active-packs");
        const dst = document.getElementById("stat-active-packs-glamtrack");
        if (src && dst) dst.textContent = src.textContent;
        // Refresh all three lists
        await renderGlamtrackUnengaged();
        await renderGlamtrackPremium();
    });

    // Sign In
    document.getElementById("nav-login").addEventListener("click", () => showActiveFrame("sec-login"));

    // Log Out
    document.getElementById("nav-logout").addEventListener("click", performSessionLogoutAction);

    // Customers > Customer Visit
    document.getElementById("nav-customer-visit")?.addEventListener("click", () => {
        showActiveFrame("sec-visit");
        // [a] Pre-fill today's date for new visit
        const vdEl = document.getElementById("utilize-visit-date");
        if (vdEl && !vdEl.value) vdEl.value = new Date().toISOString().split("T")[0];
        setTimeout(() => document.getElementById("utilize-customer-select")?.focus(), 80);
    });

    // Customers > Customer Registration
    document.getElementById("nav-customer-reg")?.addEventListener("click", () => {
        applyUserFormMode("CUSTOMER");
        showActiveFrame("sec-adm-users");
        openUserProfileModal({ quickAdd: false });
    });

    // Packages > Package Purchase
    document.getElementById("nav-package-purchase")?.addEventListener("click", () => {
        showActiveFrame("sec-allot");
        // Reset the allot form to clean state (same as clicking Reset button)
        resetAllotExistingPackUI();
        hideAllotExtraUIElements();
        // [1c] Pre-fill today's date as initial Activation Date for new sale
        const startEl = document.getElementById("allot-start-date");
        if (startEl && !startEl.value) startEl.value = new Date().toISOString().split("T")[0];
    });

    // Packages > Package Inventory
    document.getElementById("nav-package-inventory")?.addEventListener("click", () => showActiveFrame("sec-adm-packs"));

    // Services
    document.getElementById("nav-services")?.addEventListener("click", () => {
        showActiveFrame("sec-adm-catalog");
        document.getElementById("frm-adm-subservice").reset();
        document.getElementById("sub-active").checked = true;
        removeCatalogDeleteButton("btn-dynamic-sub-delete");
    });

    // Gallery — nav-gallery is permanently hidden; no action needed
    document.getElementById("nav-gallery")?.addEventListener("click", () => {});

    // Admin > Staff Registration
    document.getElementById("nav-staff-reg")?.addEventListener("click", () => {
        applyUserFormMode("MANAGER");
        showActiveFrame("sec-adm-users");
        openUserProfileModal({ quickAdd: false });
    });

    // Admin > Password Change
    document.getElementById("nav-change-pwd")?.addEventListener("click", () => showActiveFrame("sec-change-password"));

    document.getElementById("frm-change-password")?.addEventListener("submit", processChangePasswordSubmission);

    // Legacy IDs kept for backward compat (no-op, already hidden)
    document.getElementById("nav-adm-users-custstaff")?.addEventListener("click", () => {});
    document.getElementById("nav-adm-users-changepwd")?.addEventListener("click", () => {});
    document.getElementById("nav-adm-catalog")?.addEventListener("click", () => {});
    document.getElementById("nav-adm-packs")?.addEventListener("click", () => {});
    document.getElementById("nav-dashboard")?.addEventListener("click", () => {});
    
    // UI Change interceptor for structural dual-factor verification
    document.getElementById("txt-login-role").addEventListener("change", (e) => {
        const passwordGroup = document.getElementById("grp-login-pass");
        const existingOtp = document.getElementById("grp-otp-challenge");
        if (existingOtp) existingOtp.remove();

        if (e.target.value === "SUPER_USER") {
            passwordGroup.insertAdjacentHTML('beforebegin', `
                <div class="mb-3" id="grp-otp-challenge">
                    <label class="form-label fw-bold text-danger small">Enter 6-Digit System Admin OTP Security Token</label>
                    <input type="text" class="form-control" id="txt-login-otp" placeholder="e.g., 123456" maxlength="6">
                </div>
            `);
            passwordGroup.style.display = "none";
        } else {
            passwordGroup.style.display = "block";
        }
    });
    
    document.getElementById("btn-execute-auth").addEventListener("click", processSecureProfileAuthentication);
    document.getElementById("btn-trigger-autopopulate").addEventListener("click", executeDynamicAutopopulateMenuTask);
    
    // Core Administrative Entity Lifecycle Pipelines
    document.getElementById("frm-adm-category").addEventListener("submit", processCategoryADMFormSubmission);
    document.getElementById("frm-adm-service").addEventListener("submit", processServiceADMFormSubmission);
    document.getElementById("frm-adm-subservice").addEventListener("submit", processSubServiceFormSubmission);
    document.getElementById("btn-reset-subservice")?.addEventListener("click", () => {
        document.getElementById("frm-adm-subservice").reset();
        document.getElementById("sub-active").checked = true;
        removeCatalogDeleteButton("btn-dynamic-sub-delete");
    });
    document.getElementById("frm-adm-commonpack").addEventListener("submit", processCommonPackADMFormSubmission);
    document.getElementById("btn-reset-commonpack")?.addEventListener("click", () => {
        document.getElementById("frm-adm-commonpack").reset();
        document.getElementById("pack-active").checked = true;
        document.getElementById("pack-type-select").value = "Type3"; applyPackTypeUI("Type3");
        const discEl = document.getElementById("pack-discount-display");
        if (discEl) discEl.textContent = "";
        removeCatalogDeleteButton("btn-dynamic-pack-delete");
        renderCatalogSubServicesCheckboxes();
    });

    document.getElementById("frm-adm-user-profile").addEventListener("submit", processUserADMFormSubmission);
    document.getElementById("usr-role")?.addEventListener("change", (e) => {
        // Only relevant in MANAGER/STAFF (Staff Registration) mode — CUSTOMER mode hides the row entirely
        const currentMode = document.getElementById("sec-adm-users")?.dataset?.userMode;
        if (currentMode === "MANAGER") _updatePasswordRequirementForRole(e.target.value);
    });
    document.getElementById("btn-reset-userprofile")?.addEventListener("click", () => {
        // Quick-add mode (opened via "+" in Sell Package form): just close the modal
        if (_quickAddCustomerMode) {
            closeUserProfileModal();
            return;
        }
        document.getElementById("frm-adm-user-profile").reset();
        document.getElementById("usr-active").checked = true;
        removeCatalogDeleteButton("btn-dynamic-usr-delete");
        if (activeSessionUser) configureUserProfileFormForRole(activeSessionUser.role);
        const _mMsg = document.getElementById("usr-pwd-mismatch-msg"); if (_mMsg) _mMsg.style.display = "none";
        // Re-apply the current mode (CUSTOMER or MANAGER) so dynamic UI state is preserved
        const currentMode = document.getElementById("sec-adm-users")?.dataset?.userMode;
        if (currentMode) applyUserFormMode(currentMode);
    });

    // "+" Quick-add Customer button next to allot-customer-select
    document.getElementById("btn-quick-add-customer")?.addEventListener("click", () => {
        applyUserFormMode("CUSTOMER");
        openUserProfileModal({ quickAdd: true });
    });
    // Initialize Bootstrap tooltip for the "+" button
    const quickAddBtnEl = document.getElementById("btn-quick-add-customer");
    if (quickAddBtnEl && window.bootstrap?.Tooltip) {
        new bootstrap.Tooltip(quickAddBtnEl);
    }

    // Reset quick-add state whenever the modal closes by any means (Close btn, Esc, backdrop)
    document.getElementById("modal-user-profile")?.addEventListener("hidden.bs.modal", () => {
        _quickAddCustomerMode = false;
        const wrapperEl  = document.getElementById("usr-select-existing-wrapper");
        const headingEl  = document.getElementById("lbl-registered-profiles-heading");
        const cardEl     = document.getElementById("card-registered-profiles");
        const resetBtnEl = document.getElementById("btn-reset-userprofile");
        if (wrapperEl) wrapperEl.style.display = "";
        if (headingEl) headingEl.style.display = "";
        if (cardEl)    cardEl.style.display    = "";
        if (resetBtnEl) resetBtnEl.textContent = "Reset";
    });
    document.getElementById("frm-allot-membership").addEventListener("submit", processAllotmentFormSubmission);
    document.getElementById("btn-reset-allot")?.addEventListener("click", () => {
        document.getElementById("frm-allot-membership").reset();
        allotCurrentPackTotalAmount = 0;
        const previewEl = document.getElementById("allot-pack-preview");
        if (previewEl) previewEl.style.display = "none";
        const discEl = document.getElementById("allot-sold-discount");
        if (discEl) discEl.textContent = "";
        const unpaidEl = document.getElementById("allot-unpaid-display");
        if (unpaidEl) unpaidEl.textContent = "";
        const srch = document.getElementById("allot-customer-search");
        if (srch) { srch.value = ""; srch.dispatchEvent(new Event("input")); }
        const psrch = document.getElementById("allot-pack-search");
        if (psrch) psrch.value = "";
        // Reset existing-package UI state
        resetAllotExistingPackUI();
        // Also explicitly hide extra balance fields (shown only for existing packs)
        hideAllotExtraUIElements();
        // [1b-ii] Restore Reset button caption after cancel
        const resetBtn = document.getElementById("btn-reset-allot");
        if (resetBtn) resetBtn.textContent = "Reset";
        // [1c] Pre-fill today's date in Activation Date for new sale
        const startEl = document.getElementById("allot-start-date");
        if (startEl) startEl.value = new Date().toISOString().split("T")[0];
    });

    document.getElementById("btn-allot-modify")?.addEventListener("click", handleAllotModifyClick);
    document.getElementById("btn-allot-prev")?.addEventListener("click", () => { navigateAllotExistingPack(-1); });
    document.getElementById("btn-allot-next")?.addEventListener("click", () => { navigateAllotExistingPack(1); });

    // Core Security Configuration Form Submit Pipelines
    document.getElementById("frm-access-control-matrix")?.addEventListener("submit", processAccessControlFormSubmission);
    document.getElementById("frm-utilize-service-visit")?.addEventListener("submit", processVisitDeductionFormSubmission);
    document.getElementById("btn-reset-utilize")?.addEventListener("click", () => {
        document.getElementById("frm-utilize-service-visit").reset();
        // Re-check "New Visit" radio (reset() clears radio group)
        const newVisitRadio = document.getElementById("utilize-visit-new");
        if (newVisitRadio) newVisitRadio.checked = true;
        resetOldVisitUI();
        document.getElementById("container-utilize-subservices").innerHTML = "";
        utilizePrevUnpaidBalance = 0;
        const financialEl = document.getElementById("utilize-pack-financial");
        if (financialEl) financialEl.style.display = "none";
        const totalEl = document.getElementById("utilize-services-total");
        if (totalEl) { totalEl.style.display = "none"; totalEl.textContent = ""; }
        const newUnpaidEl = document.getElementById("utilize-new-unpaid-display");
        if (newUnpaidEl) newUnpaidEl.textContent = "";
        const srch = document.getElementById("utilize-customer-search");
        if (srch) { srch.value = ""; srch.dispatchEvent(new Event("input")); }
        const psrch = document.getElementById("utilize-pack-search");
        if (psrch) psrch.value = "";
        const histPanel = document.getElementById("utilize-visit-history");
        if (histPanel) histPanel.style.display = "none";
        // [a] Restore today's date after reset
        const vdEl = document.getElementById("utilize-visit-date");
        if (vdEl) vdEl.value = new Date().toISOString().split("T")[0];
        // [b] Restore Reset button caption after cancel
        const resetBtn = document.getElementById("btn-reset-utilize");
        if (resetBtn) resetBtn.textContent = "Reset";
    });
    
    // Automated reactive lookups processing links
    document.getElementById("utilize-customer-select")?.addEventListener("change", () => {
        resetOldVisitUI();
        updateCustomerAllottedPacksDropdown();
        setTimeout(() => document.getElementById("utilize-pack-select")?.focus(), 80);
    });
    document.getElementById("utilize-pack-select")?.addEventListener("change", () => {
        resetOldVisitUI();
        renderUtilizeSubServicesCheckboxes();
        setTimeout(() => document.getElementById("container-utilize-subservices")?.focus(), 80);
    });

    // Radio button: show/hide old-visit dropdown
    document.getElementById("utilize-visit-new")?.addEventListener("change", () => {
        resetOldVisitUI();
        // [b] Restore Reset caption when switching back to New Visit
        const resetBtn = document.getElementById("btn-reset-utilize");
        if (resetBtn) resetBtn.textContent = "Reset";
    });
    document.getElementById("utilize-visit-old")?.addEventListener("change", async () => {
        // [b] Change Reset caption to Cancel when Modify Old Visit is selected
        const resetBtn = document.getElementById("btn-reset-utilize");
        if (resetBtn) resetBtn.textContent = "Cancel";
        await populateOldVisitDates();
    });

    // Old visit date selected → pre-fill form
    document.getElementById("utilize-old-visit-date-select")?.addEventListener("change", () => prefillOldVisitData());

    // Delete button for old visit
    document.getElementById("btn-utilize-delete")?.addEventListener("click", () => deleteOldVisitRecord());
    document.getElementById("allot-pack-select")?.addEventListener("change", handleAllotPackSelectChange);
    document.getElementById("allot-customer-select")?.addEventListener("change", handleAllotCustomerSelectChange);

    document.getElementById("cat-select-existing")?.addEventListener("change", async (e) => {
        const selectedCode = e.target.value ? e.target.value.trim() : "";
        removeCatalogDeleteButton("btn-dynamic-cat-delete");

        if (!selectedCode) {
            document.getElementById("frm-adm-category").reset();
            document.getElementById("cat-active").checked = true;
            return;
        }

        try {
            const targetDoc = await fetchOwnerRecordByCode("serviceCategories", "catCode", selectedCode);
            if (!targetDoc) {
                console.warn(`No category record matched code signature: ${selectedCode}`);
                return;
            }

            const itemData = targetDoc.data();
            document.getElementById("cat-name").value = itemData.catName || "";
            document.getElementById("cat-desc").value = itemData.catDescription || "";
            document.getElementById("cat-active").checked = itemData.active === true;

            appendCatalogDeleteButton({
                formId: "frm-adm-category",
                buttonId: "btn-dynamic-cat-delete",
                itemName: itemData.catName || selectedCode,
                targetDocRef: targetDoc.ref,
                onDeleted: () => {
                    document.getElementById("frm-adm-category").reset();
                    document.getElementById("cat-active").checked = true;
                    removeCatalogDeleteButton("btn-dynamic-cat-delete");
                    refreshAllAdministrativeTables();
                    loadWorkspaceDropdownMappings();
                }
            });
        } catch (err) {
            console.error("Category autofill mapping pipeline runtime failure:", err);
        }
    });

    document.getElementById("srv-select-existing")?.addEventListener("change", async (e) => {
        const selectedCode = e.target.value ? e.target.value.trim() : "";
        removeCatalogDeleteButton("btn-dynamic-srv-delete");

        if (!selectedCode) {
            document.getElementById("frm-adm-service").reset();
            document.getElementById("srv-active").checked = true;
            return;
        }

        try {
            const targetDoc = await fetchOwnerRecordByCode("services", "serviceCode", selectedCode);
            if (!targetDoc) {
                console.warn(`No service record matched code signature: ${selectedCode}`);
                return;
            }

            const itemData = targetDoc.data();
            document.getElementById("srv-parent-cat").value = itemData.catCode || "";
            document.getElementById("srv-name").value = itemData.serviceName || "";
            document.getElementById("srv-desc").value = itemData.serviceDescription || "";
            document.getElementById("srv-active").checked = itemData.active === true;

            appendCatalogDeleteButton({
                formId: "frm-adm-service",
                buttonId: "btn-dynamic-srv-delete",
                itemName: itemData.serviceName || selectedCode,
                targetDocRef: targetDoc.ref,
                onDeleted: () => {
                    document.getElementById("frm-adm-service").reset();
                    document.getElementById("srv-active").checked = true;
                    removeCatalogDeleteButton("btn-dynamic-srv-delete");
                    refreshAllAdministrativeTables();
                    loadWorkspaceDropdownMappings();
                }
            });
        } catch (err) {
            console.error("Service autofill mapping pipeline runtime failure:", err);
        }
    });

    document.getElementById("usr-select-existing")?.addEventListener("change", async (e) => {
        const selectedUserNo = e.target.value ? e.target.value.trim() : "";
        removeCatalogDeleteButton("btn-dynamic-usr-delete");

        if (!selectedUserNo) {
            document.getElementById("frm-adm-user-profile").reset();
            document.getElementById("usr-active").checked = true;
            return;
        }

        try {
            const targetDoc = await fetchOwnerRecordByCode("users", "userNo", selectedUserNo);
            if (!targetDoc) {
                console.warn(`No user profile matched ID: ${selectedUserNo}`);
                return;
            }

            const itemData = targetDoc.data();
            document.getElementById("usr-role").value = itemData.role || "";
            document.getElementById("usr-fullname").value = itemData.name || "";
            document.getElementById("usr-sex").value = itemData.sex || "F";
            document.getElementById("usr-age").value = itemData.ageGroup || "";
            document.getElementById("usr-email").value = itemData.email || "";
            document.getElementById("usr-password").value = itemData.password || "";
            document.getElementById("usr-phone").value = itemData.phone || "";
            document.getElementById("usr-distance").value = itemData.distance !== undefined ? itemData.distance : "";
            document.getElementById("usr-address").value = itemData.address || "";
            document.getElementById("usr-mapurl").value = itemData.googleMapLink || "";
            document.getElementById("usr-active").checked = itemData.active === true;
            const regFeeEl = document.getElementById("usr-reg-fee");
            if (regFeeEl) regFeeEl.value = itemData.registrationFee !== null && itemData.registrationFee !== undefined ? itemData.registrationFee : "";
            const regDateEl = document.getElementById("usr-reg-date");
            if (regDateEl) regDateEl.value = itemData.registrationDate || "";

            appendCatalogDeleteButton({
                formId: "frm-adm-user-profile",
                buttonId: "btn-dynamic-usr-delete",
                itemName: itemData.name || selectedUserNo,
                targetDocRef: targetDoc.ref,
                onDeleted: () => {
                    document.getElementById("frm-adm-user-profile").reset();
                    document.getElementById("usr-active").checked = true;
                    removeCatalogDeleteButton("btn-dynamic-usr-delete");
                    refreshAllAdministrativeTables();
                    loadWorkspaceDropdownMappings();
                    const _delMode = document.getElementById("sec-adm-users")?.dataset?.userMode;
                    if (_delMode) {
                        applyUserFormMode(_delMode);
                        _refreshUserTableForMode(_delMode);
                    }
                },
                preDeleteConfirm: itemData.role === "OWNER"
                    ? () => {
                        if (!confirm(
                            `⚠️ WARNING: You are about to delete the Owner profile "${itemData.name || selectedUserNo}".

` +
                            `All data linked to this owner (sub-services, packages, customer profiles, visit logs) ` +
                            `will NOT be automatically removed from the database — it must be cleaned up manually.

` +
                            `Are you sure you want to proceed?`
                        )) return false;
                        return confirm(
                            `Final confirmation: Permanently delete Owner "${itemData.name || selectedUserNo}"?

This cannot be undone.`
                        );
                    }
                    : (itemData.role === "CUSTOMER")
                    ? async () => {
                        // [1b] Effective ownerUserNo for comparison
                        const effectiveOwnerId = (activeSessionUser.role === "OWNER")
                            ? activeSessionUser.userNo
                            : activeSessionUser.ownerUserNo;

                        // [1c] Check if customer has any record in customerServicePacks
                        const packSnap = await getDocs(query(
                            collection(db, "customerServicePacks"),
                            where("ownerUserNo", "==", effectiveOwnerId),
                            where("customerNo",  "==", itemData.userNo)
                        ));
                        if (!packSnap.empty) {
                            alert("This Customer has already been sold a Package, CANNOT delete.");
                            return false;
                        }
                        return confirm(`Are you absolutely sure you want to permanently delete "${itemData.name || selectedUserNo}"? This action cannot be reversed.`);
                    }
                    : (itemData.role === "MANAGER" || itemData.role === "STAFF")
                    ? async () => {
                        // [1b from staff req] Effective ownerUserNo for comparison
                        const effectiveOwnerId = (activeSessionUser.role === "OWNER")
                            ? activeSessionUser.userNo
                            : activeSessionUser.ownerUserNo;

                        // Check serviceUtilizationLogs serviceProviders array for this staff's userNo
                        const logsSnap = await getDocs(query(
                            collection(db, "serviceUtilizationLogs"),
                            where("ownerUserNo", "==", effectiveOwnerId)
                        ));
                        const staffUserNo = itemData.userNo;
                        let foundInVisit = false;
                        logsSnap.forEach(d => {
                            if (foundInVisit) return;
                            const providers = d.data().serviceProviders || [];
                            if (providers.some(sp => sp.userNo === staffUserNo)) {
                                foundInVisit = true;
                            }
                        });
                        if (foundInVisit) {
                            alert("Staff's record already Exists in Customer Visits, CANNOT delete this User.");
                            return false;
                        }
                        return confirm(`Are you absolutely sure you want to permanently delete "${itemData.name || selectedUserNo}"? This action cannot be reversed.`);
                    }
                    : undefined
            });
        } catch (err) {
            console.error("User profile autofill mapping pipeline runtime failure:", err);
        }
    });

    document.getElementById("pack-select-existing")?.addEventListener("change", async (e) => {
        const selectedPackName = e.target.value ? e.target.value.trim() : "";
        removeCatalogDeleteButton("btn-dynamic-pack-delete");

        if (!selectedPackName) {
            document.getElementById("frm-adm-commonpack").reset();
            document.getElementById("pack-active").checked = true;
            document.getElementById("pack-type-select").value = "Type3"; applyPackTypeUI("Type3");
            const discEl = document.getElementById("pack-discount-display");
            if (discEl) discEl.textContent = "";
            renderCatalogSubServicesCheckboxes();
            return;
        }

        try {
            const targetDoc = await fetchOwnerRecordByCode("commonServicePacks", "packName", selectedPackName);
            if (!targetDoc) {
                console.warn(`No package record matched name: ${selectedPackName}`);
                return;
            }

            const itemData = targetDoc.data();
            document.getElementById("pack-name-id").value = itemData.packName || "";
            const loadedType = itemData.packType || "Type3";
            document.getElementById("pack-type-select").value = loadedType; applyPackTypeUI(loadedType);
            document.getElementById("pack-total-amt").value = itemData.totalAmount !== undefined ? itemData.totalAmount : "";
            document.getElementById("pack-price").value = itemData.offerPrice !== undefined ? itemData.offerPrice : "";
            document.getElementById("pack-active").checked = itemData.active === true;
            updatePackDiscountDisplay();

            await renderCatalogSubServicesCheckboxes();
            const selectedCodes = itemData.subServicesArray || [];
            document.querySelectorAll(".chk-pack-subservice").forEach((input) => {
                input.checked = selectedCodes.includes(input.value);
            });
            updatePackSubServicesRunningSum();

            appendCatalogDeleteButton({
                formId: "frm-adm-commonpack",
                buttonId: "btn-dynamic-pack-delete",
                itemName: itemData.packName || selectedPackName,
                targetDocRef: targetDoc.ref,
                preDeleteConfirm: async () => {
                    const aQ = query(collection(db, "customerServicePacks"),
                        where("ownerUserNo", "==", activeSessionUser.ownerUserNo),
                        where("packName",    "==", selectedPackName));
                    const aSnap = await getDocs(aQ);
                    if (!aSnap.empty) {
                        alert(`⚠️ Deletion Blocked: "${selectedPackName}" is allotted to ${aSnap.size} customer(s). Create a new package instead.`);
                        return false;
                    }
                    return confirm(`Permanently delete "${itemData.packName || selectedPackName}"? Cannot be undone.`);
                },
                onDeleted: () => {
                    document.getElementById("frm-adm-commonpack").reset();
                    document.getElementById("pack-active").checked = true;
                    document.getElementById("pack-type-select").value = "Type3"; applyPackTypeUI("Type3");
                    const discEl = document.getElementById("pack-discount-display");
                    if (discEl) discEl.textContent = "";
                    removeCatalogDeleteButton("btn-dynamic-pack-delete");
                    renderCatalogSubServicesCheckboxes();
                    refreshAllAdministrativeTables();
                    loadWorkspaceDropdownMappings();
                }
            });
        } catch (err) {
            console.error("Package autofill mapping pipeline runtime failure:", err);
        }
    });

    document.getElementById("sub-select-existing")?.addEventListener("change", async (e) => {
        const selectedCode = e.target.value ? e.target.value.trim() : "";
        removeCatalogDeleteButton("btn-dynamic-sub-delete");

        if (!selectedCode) {
            document.getElementById("frm-adm-subservice").reset();
            document.getElementById("sub-active").checked = true;
            return;
        }

        try {
            const targetDoc = await fetchOwnerRecordByCode("subServices", "subServiceCode", selectedCode);
            if (!targetDoc) {
                console.warn(`No collection record matched code signature: ${selectedCode}`);
                return;
            }

            const itemData = targetDoc.data();
            document.getElementById("sub-parent-srv").value = itemData.serviceCode || "";
            document.getElementById("sub-name").value = itemData.subServiceName || "";
            document.getElementById("sub-rate").value = itemData.rate !== undefined ? itemData.rate : "";
            document.getElementById("sub-duration").value = itemData.durationMinutes || "";
            document.getElementById("sub-gender").value = itemData.sex || "";
            document.getElementById("sub-active").checked = itemData.active === true;

            appendCatalogDeleteButton({
                formId: "frm-adm-subservice",
                buttonId: "btn-dynamic-sub-delete",
                itemName: itemData.subServiceName || selectedCode,
                targetDocRef: targetDoc.ref,
                preDeleteConfirm: async () => {
                    // [point a] Effective ownerUserNo for comparison
                    const effectiveOwnerId = (activeSessionUser.role === "OWNER")
                        ? activeSessionUser.userNo
                        : activeSessionUser.ownerUserNo;

                    // [point b] Check if this subServiceCode is in any commonServicePacks subServicesArray
                    const packCheckSnap = await getDocs(query(
                        collection(db, "commonServicePacks"),
                        where("ownerUserNo", "==", effectiveOwnerId),
                        where("subServicesArray", "array-contains", itemData.subServiceCode)
                    ));
                    if (!packCheckSnap.empty) {
                        alert("This Sub Service is already part of some Multi-Service Package, CANNOT delete this sub-service.");
                        return false; // block deletion
                    }
                    // No package dependency — ask normal confirmation
                    return confirm(`Are you absolutely sure you want to permanently delete "${itemData.subServiceName || selectedCode}"? This action cannot be reversed.`);
                },
                onDeleted: () => {
                    document.getElementById("frm-adm-subservice").reset();
                    document.getElementById("sub-active").checked = true;
                    removeCatalogDeleteButton("btn-dynamic-sub-delete");
                    refreshAllAdministrativeTables();
                    loadWorkspaceDropdownMappings();
                    renderCatalogSubServicesCheckboxes();
                }
            });
        } catch (err) {
            console.error("Autofill mapping pipeline runtime failure:", err);
        }
    });
}

function showActiveFrame(sectionId, scrollToFormId) {
    document.querySelectorAll(".view-section").forEach(s => s.classList.remove("active"));
    const targetSection = document.getElementById(sectionId);
    if (targetSection) {
        targetSection.classList.add("active");
        if (scrollToFormId) {
            setTimeout(() => {
                const formEl = document.getElementById(scrollToFormId);
                if (formEl) formEl.scrollIntoView({ behavior: "smooth", block: "start" });
            }, 80);
        }
    }
}

function resetSessionWatchdog() {
    if (sessionWatchdogTimer) clearTimeout(sessionWatchdogTimer);
    sessionWatchdogTimer = setTimeout(() => {
        alert("Security Lockout: You have been signed out automatically due to 15 minutes of inactivity.");
        performSessionLogoutAction();
    }, INACTIVITY_TIMEOUT_MS);
}
const ACTIVITY_EVENTS = ["mousemove","keydown","click","scroll","touchstart"];
function startSessionWatchdog() {
    resetSessionWatchdog();
    ACTIVITY_EVENTS.forEach(evt => document.addEventListener(evt, resetSessionWatchdog, { passive: true }));
}
function stopSessionWatchdog() {
    if (sessionWatchdogTimer) clearTimeout(sessionWatchdogTimer);
    sessionWatchdogTimer = null;
    ACTIVITY_EVENTS.forEach(evt => document.removeEventListener(evt, resetSessionWatchdog));
}

// Wrapper to interface safely with your errorMailer layout rules
async function handleTelemetryAlert(contextLabel, errorPayload) {
    try {
        // Formatted to supply: reportRuntimeCrash(ownerName, activeSessionContext, errorObject)
        await reportRuntimeCrash(salonOwnerNameContext, activeSessionUser, {
            message: `[${contextLabel}] ${errorPayload.message || errorPayload}`,
            stack: errorPayload.stack || "No call-trace logged."
        });
    } catch (criticalLogErr) {
        console.error("Diagnostic reporting loop collapsed:", criticalLogErr);
    }
}

// =========================================================================
// Sign-In Security & Authorization Process
// =========================================================================
async function processSecureProfileAuthentication() {
    const selectedRole   = document.getElementById("txt-login-role").value;
    const emailInput     = document.getElementById("txt-login-email").value.trim().toLowerCase();
    const passwordInput  = document.getElementById("txt-login-pass") ? document.getElementById("txt-login-pass").value : "";

    // ── Helper: show inline errors ───────────────────────────────────────────
    function _loginErr(field, msg) {
        // field: 'email' | 'pass' | 'general'
        if (field === 'email') {
            const el = document.getElementById("txt-login-email");
            const fb = document.getElementById("err-login-email");
            if (el) el.classList.add("is-invalid");
            if (fb) { fb.textContent = msg; }
        } else if (field === 'pass') {
            const el = document.getElementById("txt-login-pass");
            const fb = document.getElementById("err-login-pass");
            if (el) el.classList.add("is-invalid");
            if (fb) { fb.textContent = msg; }
        } else {
            const fb = document.getElementById("err-login-general");
            if (fb) { fb.textContent = msg; fb.classList.remove("d-none"); }
        }
    }
    function _loginClearErrors() {
        ["txt-login-email","txt-login-pass"].forEach(id => {
            const el = document.getElementById(id);
            if (el) el.classList.remove("is-invalid");
        });
        const fb = document.getElementById("err-login-general");
        if (fb) { fb.textContent = ""; fb.classList.add("d-none"); }
    }
    _loginClearErrors();

    if (!emailInput) {
        _loginErr('email', 'Please enter your sign-in email address.');
        document.getElementById("txt-login-email").focus();
        return;
    }
    // Basic email format check
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailInput)) {
        _loginErr('email', 'Please enter a valid email address.');
        document.getElementById("txt-login-email").focus();
        return;
    }

    // Disable button to prevent double-submit
    const btnEl = document.getElementById("btn-execute-auth");
    if (btnEl) { btnEl.disabled = true; btnEl.textContent = "Signing in…"; }

    try {
        // --- 1. System Administrator Sign-In Link ---
        if (selectedRole === "SUPER_USER") {
            if (emailInput !== 'bawa.codes@gmail.com') {
                _loginErr('email', 'This email is not registered as a System Administrator.');
                return;
            }

            const otpInputVal = document.getElementById("txt-login-otp") ? document.getElementById("txt-login-otp").value.trim() : "";

            if (!otpInputVal) {
                const secureGeneratedToken = Math.floor(100000 + Math.random() * 900000);
                window.tempSessionOtpStorage = secureGeneratedToken;

                await emailjs.send('service_050166', 'template_050166', {
                    to_email: 'bawa.codes@gmail.com',
                    subject: "GlamTrack Security Access - Verification Code",
                    body: `Your verification code for GlamTrack Console Access is: ${secureGeneratedToken}. Code expires in 15 minutes.`
                });

                _loginErr('general', 'A secure 6-digit confirmation code has been sent to the administrator\'s email inbox.');
                return;
            }

            if (parseInt(otpInputVal, 10) !== window.tempSessionOtpStorage) {
                _loginErr('general', 'Incorrect Code: The confirmation code you entered does not match.');
                return;
            }

            delete window.tempSessionOtpStorage;

            activeSessionUser = {
                userNo: "0001",
                role: "SUPER_USER",
                name: "System Administrator",
                email: "bawa.codes@gmail.com",
                ownerUserNo: "000"
            };
            salonOwnerNameContext = "Platform Core Administration";

            renderAuthorizedWorkspaceSession();
            return;
        }

        // --- 2. Salon Owner / Manager / Staff Sign-In Link ---
        if (!passwordInput) {
            _loginErr('pass', 'Please enter your password.');
            document.getElementById("txt-login-pass").focus();
            return;
        }

        // Database Security Constraint Check
        const q = query(collection(db, "users"), where("email", "==", emailInput), where("role", "==", selectedRole));
        const res = await getDocs(q);

        if (res.empty) {
            _loginErr('general', 'Sign In Failed: No account found matching this email and role. Please check your details.');
            return;
        }

        const userDoc = res.docs[0].data();

        if (userDoc.password !== passwordInput) {
            _loginErr('pass', 'Incorrect password. Please try again.');
            document.getElementById("txt-login-pass").focus();
            return;
        }

        const isoToday = new Date().toISOString().split("T")[0];

        // Simplified Profile Status Validations
        if (userDoc.startDate && isoToday < userDoc.startDate) {
            _loginErr('general', 'Access Notice: Your staff account is not scheduled to become active yet.');
            return;
        }
        if (userDoc.expiryDate && isoToday > userDoc.expiryDate) {
            _loginErr('general', 'Access Notice: The salon management contract for this account has expired.');
            return;
        }
        if (!userDoc.active) {
            _loginErr('general', 'Access Notice: This account has been marked as inactive. Please contact your manager.');
            return;
        }

        // Set successful login session
        activeSessionUser = userDoc;
        if (activeSessionUser.role === "OWNER") {
            activeSessionUser = { ...activeSessionUser, ownerUserNo: activeSessionUser.userNo };
        }
        salonOwnerNameContext = activeSessionUser.role === "OWNER" ? activeSessionUser.name : `Salon Branch [${activeSessionUser.ownerUserNo}]`;

        renderAuthorizedWorkspaceSession();

    } catch (crash) {
        await handleTelemetryAlert("Salon Sign In Security Error", crash);
        const isOffline = !navigator.onLine;
        document.getElementById("err-login-general") &&
            (() => {
                const fb = document.getElementById("err-login-general");
                fb.textContent = isOffline
                    ? "No internet connection. Please check your network and try again."
                    : "A connection problem occurred while signing in. Please try again in a moment.";
                fb.classList.remove("d-none");
            })();
    } finally {
        if (btnEl) { btnEl.disabled = false; btnEl.textContent = "Sign In"; }
    }
}

function renderAuthorizedWorkspaceSession() {
    document.getElementById("nav-logout").classList.remove("d-none");
    document.getElementById("nav-login").classList.add("d-none");

    const role = activeSessionUser.role;

    // Background image: keep for SUPER_USER, remove for all others
    if (role === "SUPER_USER") {
        document.body.classList.add("bg-glamtrack");
        document.getElementById("sec-glamtrack").style.display = "none";
    } else {
        document.body.classList.remove("bg-glamtrack");
        // sec-glamtrack shown only for OWNER
        document.getElementById("sec-glamtrack").style.display = (role === "OWNER") ? "" : "none";
    }

    // All logged-in users see Customers, Packages, Services
    document.getElementById("nav-customers-wrapper").classList.remove("d-none");
    document.getElementById("nav-packages-wrapper").classList.remove("d-none");
    document.getElementById("nav-services").classList.remove("d-none");
    // nav-gallery remains permanently hidden

    // Admin menu: OWNER and SUPER_USER only (not MANAGER)
    if (role === "OWNER" || role === "SUPER_USER") {
        document.getElementById("nav-admin-wrapper").classList.remove("d-none");
    }

    // MANAGER: hide Staff Registration submenu item
    if (role === "MANAGER") {
        document.getElementById("nav-staff-reg")?.classList.add("d-none");
        document.getElementById("nav-admin-wrapper")?.classList.remove("d-none"); // show Admin for pwd change only
    }

    // Hide the pre-login welcome block after login
    const secHome = document.getElementById("sec-home");
    if (secHome) secHome.style.display = "none";

    // btn-trigger-autopopulate remains hidden permanently (no classList.remove("d-none"))

    // Session bar: Salon Name | Logged In as Role | Branch ID: ... | LogOut
    const salonName = (salonOwnerNameContext || "").trim();
    const salonNameEl = document.getElementById("lbl-salon-name");
    if (salonNameEl) salonNameEl.innerText = salonName;

    const roleEl = document.getElementById("lbl-logged-in-role");
    if (roleEl) roleEl.innerText = `Logged In as: ${activeSessionUser.role}`;

    // lbl-active-context now shows Branch ID last
    document.getElementById("lbl-active-context").innerText = `Branch ID: ${activeSessionUser.userNo}`;
    configureUserProfileFormForRole(activeSessionUser.role);
    startSessionWatchdog();
    showActiveFrame("sec-glamtrack");
    
    bindRealtimeAnalyticsStream();
    loadWorkspaceDropdownMappings();
    refreshAllAdministrativeTables();
    renderCatalogSubServicesCheckboxes();
}

function performSessionLogoutAction() {
    if (realtimePacksUnsubscribe) realtimePacksUnsubscribe();
    stopSessionWatchdog();
    _utilizeStaffOptions = null; // clear staff cache on logout
    activeSessionUser = null;
    window.location.reload();
    // bg-glamtrack and sec-glamtrack visibility handled on reload via renderAuthorizedWorkspaceSession
}

// =========================================================================
// Automated Data Master Creation Mechanics (Using constants.js Models)
// =========================================================================
async function getHighestFieldOffset(tableName, fieldKey) {
    let topVal = 0;
    const q = query(collection(db, tableName), where("ownerUserNo", "==", activeSessionUser.ownerUserNo)); 
    const snap = await getDocs(q);
    snap.forEach(d => {
        const parsed = parseInt(d.data()[fieldKey], 10);
        if(!isNaN(parsed) && parsed > topVal) topVal = parsed;
    });
    return topVal;
}

async function executeDynamicAutopopulateMenuTask() {
    if(!activeSessionUser) return alert("Access Failure: Session details missing.");
    const ownerId = activeSessionUser.ownerUserNo;

    try {
        const batch = writeBatch(db);
        const isoNow = new Date().toISOString().split("T")[0];
        const timestamp = new Date().toISOString();

        const offsetCat = await getHighestFieldOffset("serviceCategories", "catCode");
        const offsetSrv = await getHighestFieldOffset("services", "serviceCode");
        const offsetSub = await getHighestFieldOffset("subServices", "subServiceCode");

        const categoryMap = {}, serviceMap = {};

        // Hydrates system models safely matching your complete predefined constants schemas
        SAMPLE_CATEGORIES.forEach((c, idx) => {
            const calculatedCode = String(offsetCat + (idx + 1)).padStart(2, "0");
            categoryMap[c.catCode] = calculatedCode;
            batch.set(doc(db, "serviceCategories", `${ownerId}_CAT_${calculatedCode}`), {
                ownerUserNo: ownerId, catCode: calculatedCode, catName: c.catName, catDescription: c.catDescription,
                active: true, createdBy: activeSessionUser.role, startDate: isoNow, expiryDate: null, createdAt: timestamp
            });
        });

        SAMPLE_SERVICES.forEach((s, idx) => {
            const calculatedCode = String(offsetSrv + (idx + 1)).padStart(2, "0");
            serviceMap[s.serviceCode] = calculatedCode;
            const contextCatParent = categoryMap[s.catCode] || s.catCode;
            batch.set(doc(db, "services", `${ownerId}_SRV_${calculatedCode}`), {
                ownerUserNo: ownerId, serviceCode: calculatedCode, serviceName: s.serviceName, serviceDescription: s.serviceDescription,
                catCode: contextCatParent, active: true, createdBy: activeSessionUser.role, startDate: isoNow, expiryDate: null, createdAt: timestamp
            });
        });

        SAMPLE_SUB_SERVICES.forEach((ss, idx) => {
            const calculatedCode = String(offsetSub + (idx + 1)).padStart(3, "0");
            const contextSrvParent = serviceMap[ss.serviceCode] || ss.serviceCode;
            batch.set(doc(db, "subServices", `${ownerId}_SUB_${calculatedCode}`), {
                ownerUserNo: ownerId, subServiceCode: calculatedCode, subServiceName: ss.subServiceName, serviceCode: contextSrvParent,
                rate: Number(ss.rate), durationMinutes: Number(ss.durationMinutes), active: true, createdBy: activeSessionUser.role,
                startDate: isoNow, expiryDate: null, createdAt: timestamp
            });
        });

        await batch.commit();
        alert("Success: The standard salon service sheets and price models have been loaded into your profile.");
        refreshAllAdministrativeTables();
        loadWorkspaceDropdownMappings();
        renderCatalogSubServicesCheckboxes();
    } catch(err) {
        await handleTelemetryAlert("Autopopulate Operational Pipeline", err);
    }
}

// =========================================================================
// GlamTrack Section — Expiries, Unengaged, Premium Lists
// =========================================================================

// Full datasets cached for View More modal
let _glamtrackFullExpiries  = [];
let _glamtrackFullUnengaged = [];
let _glamtrackFullPremium   = [];

const GLAMTRACK_PREVIEW_ROWS = 5;

function _ownerFilter() {
    if (!activeSessionUser) return null;
    return (activeSessionUser.role === "OWNER")
        ? activeSessionUser.userNo
        : activeSessionUser.ownerUserNo;
}

// --- i) Expiries ---
function renderGlamtrackExpiries(packsArray) {
    const tExp = document.getElementById("tbl-dash-expiries");
    const statEl = document.getElementById("stat-expiring-glamtrack");
    const viewMoreBtn = document.getElementById("btn-viewmore-expiries");
    if (!tExp) return;

    const today = new Date();
    const limit = new Date(); limit.setDate(today.getDate() + 10);
    const todayStr = today.toISOString().split("T")[0];
    const limitStr = limit.toISOString().split("T")[0];

    _glamtrackFullExpiries = packsArray.filter(p => {
        if (!p.expiryDate) return false;
        return p.expiryDate >= todayStr && p.expiryDate <= limitStr;
    }).sort((a, b) => a.expiryDate.localeCompare(b.expiryDate));

    if (statEl) statEl.textContent = _glamtrackFullExpiries.length;

    const rows = _glamtrackFullExpiries.slice(0, GLAMTRACK_PREVIEW_ROWS);
    tExp.innerHTML = rows.length === 0
        ? `<tr><td colspan="4" class="text-center text-muted py-2">No packages expiring within the next 10 days.</td></tr>`
        : rows.map(p => `
            <tr>
                <td><strong>Client #${p.customerNo}</strong></td>
                <td>${p.packName}</td>
                <td class="text-primary small" style="cursor:pointer;text-decoration:underline;"
                    onclick="navigator.clipboard.writeText('${p.phone||''}');alert('Phone copied for Client #${p.customerNo}')">Copy Phone</td>
                <td><span class="badge bg-danger">${p.expiryDate}</span></td>
            </tr>`).join("");

    if (viewMoreBtn) viewMoreBtn.classList.toggle("d-none", _glamtrackFullExpiries.length <= GLAMTRACK_PREVIEW_ROWS);
}

// --- ii) Unengaged Customers ---
async function renderGlamtrackUnengaged() {
    const tbody = document.getElementById("tbl-glamtrack-unengaged");
    const statEl = document.getElementById("stat-unengaged-glamtrack");
    const viewMoreBtn = document.getElementById("btn-viewmore-unengaged");
    if (!tbody || !activeSessionUser) return;

    const ownerMatch = _ownerFilter();
    if (!ownerMatch) return;
    tbody.innerHTML = `<tr><td colspan="5" class="text-center text-muted py-2">Loading…</td></tr>`;

    try {
        const cutoff = new Date(); cutoff.setDate(cutoff.getDate() - 180);
        const cutoffStr = cutoff.toISOString().split("T")[0];

        const packsQ = query(collection(db, "customerServicePacks"), where("ownerUserNo", "==", ownerMatch));
        const packsSnap = await getDocs(packsQ);

        const unengagedMap = new Map();
        packsSnap.forEach(d => {
            const p = d.data();
            const key = `${p.customerNo}|${p.ownerUserNo}`;
            const startOld = !p.lastVisitDate && p.startDate && p.startDate <= cutoffStr;
            const lastVisitOld = p.lastVisitDate && p.lastVisitDate <= cutoffStr;
            if (startOld || lastVisitOld) {
                const lv = p.lastVisitDate || p.startDate || "";
                const existing = unengagedMap.get(key);
                if (!existing || lv > (existing.lastVisit || ""))
                    unengagedMap.set(key, { customerNo: p.customerNo, ownerUserNo: p.ownerUserNo, lastVisit: lv });
            }
        });

        const logsQ = query(collection(db, "serviceUtilizationLogs"), where("ownerUserNo", "==", ownerMatch));
        const logsSnap = await getDocs(logsQ);
        const logsMaxMap = new Map();
        logsSnap.forEach(d => {
            const l = d.data();
            const key = `${l.customerNo}|${l.ownerUserNo}`;
            const cur = logsMaxMap.get(key) || "";
            if ((l.visitDate || "") > cur) logsMaxMap.set(key, l.visitDate || "");
        });
        logsMaxMap.forEach((maxVisitDate, key) => {
            if (maxVisitDate <= cutoffStr) {
                const [customerNo, ownerUserNo] = key.split("|");
                const existing = unengagedMap.get(key);
                if (!existing || maxVisitDate > (existing.lastVisit || ""))
                    unengagedMap.set(key, { customerNo, ownerUserNo, lastVisit: maxVisitDate });
            }
        });

        if (unengagedMap.size === 0) {
            if (statEl) statEl.textContent = "0";
            tbody.innerHTML = `<tr><td colspan="5" class="text-center text-muted py-2">No unengaged customers found.</td></tr>`;
            if (viewMoreBtn) viewMoreBtn.classList.add("d-none");
            return;
        }

        const usersQ = query(collection(db, "users"), where("ownerUserNo", "==", ownerMatch), where("role", "==", "CUSTOMER"));
        const usersSnap = await getDocs(usersQ);
        const usersMap = new Map();
        usersSnap.forEach(d => { const u = d.data(); usersMap.set(u.userNo, u); });

        _glamtrackFullUnengaged = Array.from(unengagedMap.values()).map(r => {
            const u = usersMap.get(r.customerNo) || {};
            return { ...r, name: u.name || "—", phone: u.phone || "—", email: u.email || "—" };
        }).sort((a, b) => (a.lastVisit || "").localeCompare(b.lastVisit || ""));

        if (statEl) statEl.textContent = _glamtrackFullUnengaged.length;
        const rows = _glamtrackFullUnengaged.slice(0, GLAMTRACK_PREVIEW_ROWS);
        tbody.innerHTML = rows.map(r => `
            <tr>
                <td><strong>#${r.customerNo}</strong></td>
                <td>${r.name}</td><td>${r.phone}</td><td>${r.email}</td>
                <td>${r.lastVisit || "—"}</td>
            </tr>`).join("");
        if (viewMoreBtn) viewMoreBtn.classList.toggle("d-none", _glamtrackFullUnengaged.length <= GLAMTRACK_PREVIEW_ROWS);

    } catch(err) { await handleTelemetryAlert("GlamTrack Unengaged Customers", err); }
}

// --- iii) Premium Customers ---
async function renderGlamtrackPremium() {
    const tbody = document.getElementById("tbl-glamtrack-premium");
    const statEl = document.getElementById("stat-premium-glamtrack");
    const viewMoreBtn = document.getElementById("btn-viewmore-premium");
    if (!tbody || !activeSessionUser) return;

    const ownerMatch = _ownerFilter();
    if (!ownerMatch) return;
    tbody.innerHTML = `<tr><td colspan="5" class="text-center text-muted py-2">Loading…</td></tr>`;

    try {
        const cutoff = new Date(); cutoff.setDate(cutoff.getDate() - 400);
        const cutoffStr = cutoff.toISOString().split("T")[0];

        const packsQ = query(collection(db, "customerServicePacks"), where("ownerUserNo", "==", ownerMatch));
        const packsSnap = await getDocs(packsQ);

        const spendMap = new Map();
        packsSnap.forEach(d => {
            const p = d.data();
            if (!p.startDate || p.startDate < cutoffStr) return;
            spendMap.set(p.customerNo, (spendMap.get(p.customerNo) || 0) + Number(p.soldPrice || 0));
        });

        const premiumEntries = Array.from(spendMap.entries())
            .filter(([, t]) => t > 20000)
            .sort(([, a], [, b]) => b - a);

        if (premiumEntries.length === 0) {
            if (statEl) statEl.textContent = "0";
            tbody.innerHTML = `<tr><td colspan="5" class="text-center text-muted py-2">No premium customers found.</td></tr>`;
            if (viewMoreBtn) viewMoreBtn.classList.add("d-none");
            return;
        }

        const usersQ = query(collection(db, "users"), where("ownerUserNo", "==", ownerMatch), where("role", "==", "CUSTOMER"));
        const usersSnap = await getDocs(usersQ);
        const usersMap = new Map();
        usersSnap.forEach(d => { const u = d.data(); usersMap.set(u.userNo, u); });

        _glamtrackFullPremium = premiumEntries.map(([customerNo, totalSpend]) => {
            const u = usersMap.get(customerNo) || {};
            return { customerNo, totalSpend, name: u.name||"—", phone: u.phone||"—", email: u.email||"—" };
        });

        if (statEl) statEl.textContent = _glamtrackFullPremium.length;
        const rows = _glamtrackFullPremium.slice(0, GLAMTRACK_PREVIEW_ROWS);
        const isOwner = activeSessionUser?.role === "OWNER";
        tbody.innerHTML = rows.map(r => `
            <tr>
                <td><strong>#${r.customerNo}</strong></td>
                <td>${r.name}</td><td>${r.phone}</td><td>${r.email}</td>
                ${isOwner ? `<td class="fw-bold text-success">₹${Number(r.totalSpend).toLocaleString("en-IN")}</td>` : "<td>—</td>"}
            </tr>`).join("");
        // Show/hide Total Spend column header based on role
        const premiumThead = document.querySelector("#tbl-glamtrack-premium thead tr th:last-child");
        if (premiumThead) premiumThead.style.display = isOwner ? "" : "none";
        if (viewMoreBtn) viewMoreBtn.classList.toggle("d-none", _glamtrackFullPremium.length <= GLAMTRACK_PREVIEW_ROWS);

    } catch(err) { await handleTelemetryAlert("GlamTrack Premium Customers", err); }
}

// --- Scroll to glamtrack list section on stat card click ---
function scrollToGlamtrackSection(sectionId) {
    const el = document.getElementById(sectionId);
    if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
}

// --- View More Modal ---
function openGlamtrackModal(type) {
    let title = "", headHtml = "", rows = [];
    if (type === "expiries") {
        title = "Packages Expiring in 10 Days";
        headHtml = `<tr><th>Customer ID</th><th>Package Name</th><th>Phone</th><th>Expiry Date</th></tr>`;
        rows = _glamtrackFullExpiries.map(p => `<tr><td><strong>Client #${p.customerNo}</strong></td><td>${p.packName}</td><td>${p.phone||"—"}</td><td><span class="badge bg-danger">${p.expiryDate}</span></td></tr>`);
    } else if (type === "unengaged") {
        title = "Unengaged Customers (No Visit in last 6M)";
        headHtml = `<tr><th>Customer ID</th><th>Name</th><th>Phone</th><th>Email</th><th>Last Visit</th></tr>`;
        rows = _glamtrackFullUnengaged.map(r => `<tr><td><strong>#${r.customerNo}</strong></td><td>${r.name}</td><td>${r.phone}</td><td>${r.email}</td><td>${r.lastVisit||"—"}</td></tr>`);
    } else if (type === "premium") {
        title = "Premium Customers";
        const isOwnerModal = activeSessionUser?.role === "OWNER";
        headHtml = `<tr><th>Customer ID</th><th>Name</th><th>Phone</th><th>Email</th>${isOwnerModal ? "<th>Total Spend (₹)</th>" : ""}</tr>`;
        rows = _glamtrackFullPremium.map(r => `<tr><td><strong>#${r.customerNo}</strong></td><td>${r.name}</td><td>${r.phone}</td><td>${r.email}</td>${isOwnerModal ? `<td class="fw-bold text-success">₹${Number(r.totalSpend).toLocaleString("en-IN")}</td>` : ""}</tr>`);
    }
    document.getElementById("glamtrackModalTitle").textContent = title;
    document.getElementById("glamtrackModalHead").innerHTML = headHtml;
    document.getElementById("glamtrackModalBody").innerHTML = rows.join("") || `<tr><td colspan="5" class="text-center text-muted py-2">No records.</td></tr>`;
    new bootstrap.Modal(document.getElementById("glamtrackModal")).show();
}

// =========================================================================
// Real-Time Analytics Monitoring Subsystem
// =========================================================================
function bindRealtimeAnalyticsStream() {
    const ownerId = activeSessionUser.ownerUserNo;
    const qPacks = query(collection(db, "customerServicePacks"), where("ownerUserNo", "==", ownerId));

    realtimePacksUnsubscribe = onSnapshot(qPacks, async (snapshot) => {
        try {
            const packsArray = [];
            snapshot.forEach(d => packsArray.push(d.data()));

            const activeCnt = packsArray.filter(p => p.active).length;
            document.getElementById("stat-active-packs").innerText = activeCnt;
            const glamtrackStat = document.getElementById("stat-active-packs-glamtrack");
            if (glamtrackStat) glamtrackStat.textContent = activeCnt;

            // Render expiries list (now lives in sec-glamtrack)
            renderGlamtrackExpiries(packsArray);

            // Refresh unengaged + premium lists
            await renderGlamtrackUnengaged();
            await renderGlamtrackPremium();

        } catch(err) {
            await handleTelemetryAlert("Realtime Dashboard Live Engine", err);
        }
    });
}

// =========================================================================
// Dynamic Checkbox Generation - Reference Master Packs
// =========================================================================
async function renderCatalogSubServicesCheckboxes() {
    if (!activeSessionUser) return;
    const container = document.getElementById("container-pack-subservices");
    if (!container) return;

    try {
        const q = query(collection(db, "subServices"), where("ownerUserNo", "==", activeSessionUser.ownerUserNo), where("active", "==", true)); 
        const snap = await getDocs(q);

        // Join with services collection on serviceCode + ownerUserNo to get serviceName
        const srvNameMap = new Map();
        const srvSnap = await getDocs(query(collection(db, "services"), where("ownerUserNo", "==", activeSessionUser.ownerUserNo)));
        srvSnap.forEach(d => {
            const s = d.data();
            srvNameMap.set(s.serviceCode, s.serviceName);
        });

        const srchBox = document.getElementById("pack-subservices-search");
        if (srchBox) srchBox.value = "";
        container.innerHTML = "";
        if (snap.empty) {
            container.innerHTML = `<p class="text-danger small my-0">No active menu service items found. Please setup or load standard menus first.</p>`;
            return;
        }

        snap.forEach(d => {
            const ss = d.data();
            const parentServiceName = srvNameMap.get(ss.serviceCode) || "";
            const displayLabel = parentServiceName ? `${ss.subServiceName} (${parentServiceName})` : ss.subServiceName;
            container.innerHTML += `
                <div class="form-check">
                    <input class="form-check-input chk-pack-subservice" type="checkbox" value="${ss.subServiceCode}" data-rate="${ss.rate}" id="chk-ss-${ss.subServiceCode}">
                    <label class="form-check-label small" for="chk-ss-${ss.subServiceCode}">
                        ${displayLabel} (₹${ss.rate})
                    </label>
                </div>`;
        });
        updatePackSubServicesRunningSum();
    } catch (err) { await handleTelemetryAlert("Catalog Checkbox Mapping Engine", err); }
}

// =========================================================================
// Structural Administration Form Submission Handlers
// =========================================================================
async function processCategoryADMFormSubmission(e) {
    e.preventDefault();
    const existingCode = document.getElementById("cat-select-existing").value;
    const name = document.getElementById("cat-name").value.trim();
    const desc = document.getElementById("cat-desc").value.trim();
    const activeFlag = document.getElementById("cat-active").checked;
    
    try {
        let targetCode = existingCode;
        let isNewItem = false;

        if (!targetCode) {
            isNewItem = true;
            targetCode = String(await getHighestFieldOffset("serviceCategories", "catCode") + 1).padStart(2, "0");
        }

        await setDoc(doc(db, "serviceCategories", `${activeSessionUser.ownerUserNo}_CAT_${targetCode}`), {
            ownerUserNo: activeSessionUser.ownerUserNo, catCode: targetCode, catName: name, catDescription: desc,
            active: activeFlag, createdBy: activeSessionUser.role, startDate: new Date().toISOString().split("T")[0],
            expiryDate: null, createdAt: new Date().toISOString()
        });

        alert(isNewItem ? "Success: Menu category added successfully." : `✅ Success: Changes saved for "${name}".`);

        document.getElementById("frm-adm-category").reset();
        document.getElementById("cat-active").checked = true;
        removeCatalogDeleteButton("btn-dynamic-cat-delete");

        refreshAllAdministrativeTables();
        loadWorkspaceDropdownMappings();
    } catch(err) { await handleTelemetryAlert("Category Storage Submission Pipeline", err); }
}

async function processServiceADMFormSubmission(e) {
    e.preventDefault();
    const existingCode = document.getElementById("srv-select-existing").value;
    const parentCat = document.getElementById("srv-parent-cat").value;
    const name = document.getElementById("srv-name").value.trim();
    const desc = document.getElementById("srv-desc").value.trim();
    const activeFlag = document.getElementById("srv-active").checked;

    try {
        let targetCode = existingCode;
        let isNewItem = false;

        if (!targetCode) {
            isNewItem = true;
            targetCode = String(await getHighestFieldOffset("services", "serviceCode") + 1).padStart(2, "0");
        }

        await setDoc(doc(db, "services", `${activeSessionUser.ownerUserNo}_SRV_${targetCode}`), {
            ownerUserNo: activeSessionUser.ownerUserNo, serviceCode: targetCode, serviceName: name, serviceDescription: desc,
            catCode: parentCat, active: activeFlag, createdBy: activeSessionUser.role, startDate: new Date().toISOString().split("T")[0],
            expiryDate: null, createdAt: new Date().toISOString()
        });

        alert(isNewItem ? "Success: Main service group added successfully." : `✅ Success: Changes saved for "${name}".`);

        document.getElementById("frm-adm-service").reset();
        document.getElementById("srv-active").checked = true;
        removeCatalogDeleteButton("btn-dynamic-srv-delete");

        refreshAllAdministrativeTables();
        loadWorkspaceDropdownMappings();
    } catch(err) { await handleTelemetryAlert("Service Storage Submission Pipeline", err); }
}

async function processSubServiceFormSubmission(e) {
    e.preventDefault();
    
    const existingCode = document.getElementById("sub-select-existing").value;
    const parentSrv = document.getElementById("sub-parent-srv").value;
    const name = document.getElementById("sub-name").value.trim();
    const rate = document.getElementById("sub-rate").value;
    const duration = document.getElementById("sub-duration").value;
    const activeFlag = document.getElementById("sub-active").checked;
    const gender = document.getElementById("sub-gender").value;
    if (!parentSrv) return alert("Validation: Please select a Main Service this item belongs to.");
    if (!name)      return alert("Validation: Please enter a name for this service item.");
    try {
        let targetCode = existingCode;
        let isNewItem = false;

        if (!targetCode) {
            isNewItem = true;
            targetCode = String(await getHighestFieldOffset("subServices", "subServiceCode") + 1).padStart(3, "0");
        }

        await setDoc(doc(db, "subServices", `${activeSessionUser.ownerUserNo}_SUB_${targetCode}`), {
            ownerUserNo: activeSessionUser.ownerUserNo,
            subServiceCode: targetCode,
            subServiceName: name,
            serviceCode: parentSrv,
            rate: Number(rate),
            durationMinutes: Number(duration),
            sex: gender || null,
            active: activeFlag,
            createdBy: activeSessionUser.role,
            startDate: new Date().toISOString().split("T")[0],
            expiryDate: null,
            createdAt: new Date().toISOString()
        });

        alert(isNewItem ? `✨ Success: "${name}" added to menu!` : `✅ Success: Changes saved.`);

        document.getElementById("frm-adm-subservice").reset();
        document.getElementById("sub-active").checked = true;
        
        const oldDelBtn = document.getElementById("btn-dynamic-sub-delete");
        if (oldDelBtn) oldDelBtn.remove();
        
        refreshAllAdministrativeTables();
        loadWorkspaceDropdownMappings();
        renderCatalogSubServicesCheckboxes();
    } catch(err) { 
        console.error("Subservice storage execution breakdown:", err); 
    }
}

async function processCommonPackADMFormSubmission(e) {
    e.preventDefault();

    const existingPackName = document.getElementById("pack-select-existing").value;
    const nameId    = document.getElementById("pack-name-id").value.trim();
    const type      = document.getElementById("pack-type-select").value;
    const price     = parseFloat(document.getElementById("pack-price").value) || 0;
    const totalAmt  = parseFloat(document.getElementById("pack-total-amt").value) || 0;
    const activeFlag = document.getElementById("pack-active").checked;

    // Point 17: price cannot exceed totalAmt
    if (price > totalAmt)
        return alert("Validation Error: Price Offered (₹" + price.toLocaleString("en-IN") + ") cannot exceed Total Price (₹" + totalAmt.toLocaleString("en-IN") + "). Please correct before saving.");

    const selectedSubServices = [];
    document.querySelectorAll(".chk-pack-subservice:checked").forEach(input => selectedSubServices.push(input.value));
    // Type2: at least one subservice required. Type3: zero is allowed (excluded items list can be empty).
    if (type === "Type2" && selectedSubServices.length === 0)
        return alert("Validation: Please select at least one Individual Service Item for this package before saving.");

    if (totalAmt > 0) {
        const minAllowed = totalAmt * 0.15;
        if (price > totalAmt) {
            const go = confirm(`⚠️ Price Alert: Offered Price (₹${price.toLocaleString("en-IN")}) exceeds Total Services Price (₹${totalAmt.toLocaleString("en-IN")}). Proceed anyway?`);
            if (!go) return;
        } else if (price < minAllowed) {
            const go = confirm(`⚠️ Price Alert: Offered Price (₹${price.toLocaleString("en-IN")}) is below 15% of Total (₹${minAllowed.toLocaleString("en-IN",{maximumFractionDigits:0})} min). Proceed anyway?`);
            if (!go) return;
        }
    }

    try {
        let packDocRef;
        let isNewItem = false;

        if (existingPackName) {
            const targetDoc = await fetchOwnerRecordByCode("commonServicePacks", "packName", existingPackName);
            if (!targetDoc) return alert("Update blocked: Could not find the selected package in the catalog.");
            const allotQ = query(collection(db, "customerServicePacks"),
                where("ownerUserNo", "==", activeSessionUser.ownerUserNo),
                where("packName",    "==", existingPackName));
            const allotSnap = await getDocs(allotQ);
            if (!allotSnap.empty)
                return alert(`⚠️ Modification Blocked: "${existingPackName}" is allotted to ${allotSnap.size} customer(s). Create a new package instead.`);
            // (c) Use the SAME document ref regardless of name change — no new doc created
            packDocRef = targetDoc.ref;
        } else {
            isNewItem = true;
            // (b) ID format: <ownerUserNo>_PACK_<first3LettersOfName><serial>
            const prefix = nameId.replace(/\s+/g, "").substring(0, 3).toUpperCase();
            // Find next serial: query all packs for this owner whose packId starts with this prefix
            const allPacksQ = query(collection(db, "commonServicePacks"),
                where("ownerUserNo", "==", activeSessionUser.ownerUserNo));
            const allPacksSnap = await getDocs(allPacksQ);
            let maxSerial = 0;
            const prefixPattern = new RegExp(`^${activeSessionUser.ownerUserNo}_PACK_${prefix}(\\d+)$`);
            allPacksSnap.forEach(d => {
                const m = d.id.match(prefixPattern);
                if (m) { const n = parseInt(m[1], 10); if (n > maxSerial) maxSerial = n; }
            });
            const serial = maxSerial + 1;
            packDocRef = doc(db, "commonServicePacks", `${activeSessionUser.ownerUserNo}_PACK_${prefix}${serial}`);
        }

        await setDoc(packDocRef, {
            ownerUserNo: activeSessionUser.ownerUserNo,
            id: packDocRef.id,
            packName: nameId, packType: type,
            offerPrice: price, totalAmount: totalAmt,
            subServicesArray: selectedSubServices,
            active: activeFlag, createdAt: new Date().toISOString()
        });

        alert(isNewItem ? "Success: New pre-paid package added." : `✅ Success: Changes saved for "${nameId}".`);
        document.getElementById("frm-adm-commonpack").reset();
        document.getElementById("pack-active").checked = true;
        document.getElementById("pack-type-select").value = "Type3"; applyPackTypeUI("Type3");
        const discEl2 = document.getElementById("pack-discount-display");
        if (discEl2) discEl2.textContent = "";
        removeCatalogDeleteButton("btn-dynamic-pack-delete");
        renderCatalogSubServicesCheckboxes();
        refreshAllAdministrativeTables();
        loadWorkspaceDropdownMappings();
    } catch(err) { await handleTelemetryAlert("Master Package Creation Node", err); }
}

function configureUserProfileFormForRole(loggedInRole) {
    const roleSelect = document.getElementById("usr-role");
    const distWrapper = document.getElementById("usr-distance-wrapper");
    if (!roleSelect) return;
    const ownerOpt = roleSelect.querySelector("option[value='OWNER']");
    const mgrOpt   = roleSelect.querySelector("option[value='MANAGER']");
    const custOpt  = roleSelect.querySelector("option[value='CUSTOMER']");
    if (loggedInRole === "SUPER_USER") {
        if (ownerOpt) ownerOpt.hidden = false;
        if (mgrOpt)   mgrOpt.hidden   = true;
        if (custOpt)  custOpt.hidden   = true;
        if (distWrapper) distWrapper.hidden = true;
    } else {
        if (ownerOpt) ownerOpt.hidden = true;
        if (mgrOpt)   mgrOpt.hidden   = false;
        if (custOpt)  custOpt.hidden   = false;
        if (distWrapper) distWrapper.hidden = false;
    }
}
async function processUserADMFormSubmission(e) {
    e.preventDefault();
    const existingUserNo = document.getElementById("usr-select-existing").value;
    const role = document.getElementById("usr-role").value;
    const name = document.getElementById("usr-fullname").value.trim();
    const sex = document.getElementById("usr-sex").value;
    const age = document.getElementById("usr-age").value;
    const email = document.getElementById("usr-email").value.trim().toLowerCase();
    const pass = document.getElementById("usr-password").value;
    const confirmPass = document.getElementById("usr-confirm-password").value;
    const mismatchMsg = document.getElementById("usr-pwd-mismatch-msg");

    // Confirm Password match check — required for MANAGER/OWNER, optional for CUSTOMER
    if (pass || confirmPass) {
        if (pass !== confirmPass) {
            if (mismatchMsg) mismatchMsg.style.display = "block";
            document.getElementById("usr-confirm-password").focus();
            return;
        }
    }
    if (mismatchMsg) mismatchMsg.style.display = "none";

    const phone = document.getElementById("usr-phone").value.trim();
    if ((role === "MANAGER" || role === "OWNER") && !pass.trim())
        return alert("Validation Error: Password is required for MANAGER and OWNER profiles.");
    const dist = document.getElementById("usr-distance").value;
    const addr = document.getElementById("usr-address").value.trim();
    const maps = document.getElementById("usr-mapurl").value.trim();
    const activeFlag = document.getElementById("usr-active").checked;
    const regFeeRaw = document.getElementById("usr-reg-fee")?.value;
    const regFee = (regFeeRaw !== "" && regFeeRaw !== undefined && !isNaN(parseFloat(regFeeRaw)) && parseFloat(regFeeRaw) >= 0)
        ? parseFloat(regFeeRaw) : null;
    const regDate = document.getElementById("usr-reg-date")?.value || null;

    try {
        let targetUserNo = existingUserNo;
        let isNewItem = false;

        if (!targetUserNo) {
            isNewItem = true;

            if (role === "CUSTOMER") {
                // 4-digit sequential, scoped to this owner
                const q = query(collection(db, "users"),
                    where("ownerUserNo", "==", activeSessionUser.ownerUserNo),
                    where("role", "==", "CUSTOMER"));
                const snap = await getDocs(q);
                let maxNo = 0;
                snap.forEach(d => { const n = parseInt(d.data().userNo, 10); if (!isNaN(n) && n > maxNo) maxNo = n; });
                targetUserNo = String(maxNo + 1).padStart(4, "0");
            } else if (role === "MANAGER") {
                // 3-digit sequential, scoped to this owner
                const q = query(collection(db, "users"),
                    where("ownerUserNo", "==", activeSessionUser.ownerUserNo),
                    where("role", "==", "MANAGER"));
                const snap = await getDocs(q);
                let maxNo = 0;
                snap.forEach(d => { const n = parseInt(d.data().userNo, 10); if (!isNaN(n) && n > maxNo) maxNo = n; });
                targetUserNo = String(maxNo + 1).padStart(3, "0");
            } else if (role === "STAFF") {
                // 3-digit sequential, scoped to this owner
                const q = query(collection(db, "users"),
                    where("ownerUserNo", "==", activeSessionUser.ownerUserNo),
                    where("role", "==", "STAFF"));
                const snap = await getDocs(q);
                let maxNo = 0;
                snap.forEach(d => { const n = parseInt(d.data().userNo, 10); if (!isNaN(n) && n > maxNo) maxNo = n; });
                targetUserNo = String(maxNo + 1).padStart(3, "0");
            } else if (role === "OWNER") {
                // 3-digit sequential across ALL owners — query SUPER_USER scope (ownerUserNo='000')
                const q = query(collection(db, "users"),
                    where("ownerUserNo", "==", "000"),
                    where("role", "==", "OWNER"));
                const snap = await getDocs(q);
                let maxNo = 0;
                snap.forEach(d => { const n = parseInt(d.data().userNo, 10); if (!isNaN(n) && n > maxNo) maxNo = n; });
                targetUserNo = String(maxNo + 1).padStart(3, "0");
            }
        }

        // Build document ID and ownerUserNo per role
        let docId, recordOwnerUserNo;

        if (!isNewItem) {
            // Modifying an existing record — fetch the actual Firestore doc ID
            // to avoid creating a duplicate document with a differently-formatted ID
            const existingDoc = await fetchOwnerRecordByCode("users", "userNo", targetUserNo);
            if (!existingDoc) return alert("Error: Could not locate the existing profile to update.");
            docId = existingDoc.id;
            recordOwnerUserNo = existingDoc.data().ownerUserNo;
        } else if (role === "CUSTOMER") {
            recordOwnerUserNo = activeSessionUser.ownerUserNo;
            docId = `${recordOwnerUserNo}_USR_${targetUserNo}`;
        } else if (role === "MANAGER") {
            recordOwnerUserNo = activeSessionUser.ownerUserNo;
            docId = `${recordOwnerUserNo}_USR_${targetUserNo}`;
        } else if (role === "STAFF") {
            recordOwnerUserNo = activeSessionUser.ownerUserNo;
            docId = `${recordOwnerUserNo}_USR_${targetUserNo}`;
        } else if (role === "OWNER") {
            recordOwnerUserNo = targetUserNo;
            docId = `${targetUserNo}_USR_${targetUserNo}`;
        } else {
            recordOwnerUserNo = activeSessionUser.ownerUserNo;
            docId = `${recordOwnerUserNo}_USR_${targetUserNo}`;
        }
        await setDoc(doc(db, "users", docId), {
            ownerUserNo: recordOwnerUserNo, userNo: targetUserNo, role: role, name: name, sex: sex,
            ageGroup: age, email: email, password: pass, phone: phone, distance: dist, address: addr,
            googleMapLink: maps, active: activeFlag, registrationFee: regFee, registrationDate: regDate,
            startDate: new Date().toISOString().split("T")[0], createdAt: new Date().toISOString()
        });

        // Quick-add mode: close modal and auto-populate allot-customer-select, skip normal reset flow
        if (_quickAddCustomerMode) {
            alert(isNewItem
                ? `Success: Profile record file registered successfully as a salon ${role}.`
                : `✅ Success: Changes saved for "${name}".`);

            removeCatalogDeleteButton("btn-dynamic-usr-delete");
            refreshAllAdministrativeTables();
            await loadWorkspaceDropdownMappings(); // ensures allot-customer-select has the new option

            closeUserProfileModal();
            _quickAddCustomerMode = false;

            // Auto-populate allot-customer-select with the newly saved customer's userNo
            const allotCustSelect = document.getElementById("allot-customer-select");
            if (allotCustSelect) {
                allotCustSelect.value = targetUserNo;
                allotCustSelect.dispatchEvent(new Event("change"));
            }

            document.getElementById("frm-adm-user-profile").reset();
            document.getElementById("usr-active").checked = true;
            const _mMsgQA = document.getElementById("usr-pwd-mismatch-msg"); if (_mMsgQA) _mMsgQA.style.display = "none";
            return;
        }

        alert(isNewItem
            ? `Success: Profile record file registered successfully as a salon ${role}.`
            : `✅ Success: Changes saved for "${name}".`);

        document.getElementById("frm-adm-user-profile").reset();
        document.getElementById("usr-active").checked = true;
        removeCatalogDeleteButton("btn-dynamic-usr-delete");
        const _mMsgPost = document.getElementById("usr-pwd-mismatch-msg"); if (_mMsgPost) _mMsgPost.style.display = "none";

        refreshAllAdministrativeTables();
        loadWorkspaceDropdownMappings();

        // Re-apply current mode (CUSTOMER/MANAGER) so form resets to correct dynamic state
        // This also refreshes "All Active Registered Profiles List" with the correct role filter
        const _postSaveMode = document.getElementById("sec-adm-users")?.dataset?.userMode;
        if (_postSaveMode) {
            applyUserFormMode(_postSaveMode);
            _refreshUserTableForMode(_postSaveMode);
        }
    } catch(err) { await handleTelemetryAlert("User Identity Provisioning Endpoint", err); }
}

// =========================================================================
// Dynamic User Form Mode: "CUSTOMER" or "MANAGER" context
// =========================================================================
// Updates usr-password / usr-confirm-password placeholder text and required state
// based on the currently selected usr-role value. Password is mandatory for MANAGER,
// optional for STAFF (and for CUSTOMER, handled separately by hiding the row entirely).
function _updatePasswordRequirementForRole(role) {
    const pwdField     = document.getElementById("usr-password");
    const confPwdField = document.getElementById("usr-confirm-password");
    const emailEl      = document.getElementById("usr-email");
    const emailLabel   = document.getElementById("lbl-usr-email");

    if (role === "STAFF") {
        if (pwdField)     { pwdField.placeholder     = "Create Login Password (Optional for Staff)"; pwdField.required     = false; }
        if (confPwdField) { confPwdField.placeholder = "Re-enter Password (Optional for Staff)";     confPwdField.required = false; }
        // [1a] Email optional for STAFF
        if (emailEl)    { emailEl.required = false; emailEl.placeholder = "client@domain.com (Mandatory for Manager)"; }
        if (emailLabel) emailLabel.textContent = "Email Address [Optional]";
    } else {
        // MANAGER (and default/fallback)
        if (pwdField)     { pwdField.placeholder     = "Create Login Password (Mandatory for Manager)"; pwdField.required     = true; }
        if (confPwdField) { confPwdField.placeholder = "Re-enter Password (Mandatory for Manager)";     confPwdField.required = true; }
        // [1a] Email mandatory for MANAGER
        if (emailEl)    { emailEl.required = true;  emailEl.placeholder = "client@domain.com (Mandatory for Manager)"; }
        if (emailLabel) emailLabel.textContent = "Email Address";
    }
}

// =========================================================================
// User Profile Modal Helpers (shared by Customer Registration nav AND the
// "+" quick-add button in Sell Package form). Only ONE copy of
// frm-adm-user-profile exists in the DOM (inside #modal-user-profile),
// so all existing save/load/delete logic works unchanged regardless of
// which entry point opened it.
// =========================================================================
let _userProfileModalInstance = null;
let _quickAddCustomerMode = false; // true when opened via the "+" button

function _getUserProfileModalInstance() {
    const modalEl = document.getElementById("modal-user-profile");
    if (!modalEl) return null;
    if (!_userProfileModalInstance) {
        _userProfileModalInstance = new bootstrap.Modal(modalEl, { backdrop: "static" });
    }
    return _userProfileModalInstance;
}

function openUserProfileModal({ quickAdd }) {
    _quickAddCustomerMode = !!quickAdd;

    const wrapperEl   = document.getElementById("usr-select-existing-wrapper");
    const headingEl   = document.getElementById("lbl-registered-profiles-heading");
    const cardEl      = document.getElementById("card-registered-profiles");
    const resetBtnEl  = document.getElementById("btn-reset-userprofile");

    if (_quickAddCustomerMode) {
        // Hide "choose existing" dropdown + its wrapper
        if (wrapperEl) wrapperEl.style.display = "none";
        // Hide "Registered Profiles" heading + table card
        if (headingEl) headingEl.style.display = "none";
        if (cardEl)    cardEl.style.display    = "none";
        // Relabel Reset -> Close
        if (resetBtnEl) resetBtnEl.textContent = "Close";
    } else {
        if (wrapperEl) wrapperEl.style.display = "";
        if (headingEl) headingEl.style.display = "";
        if (cardEl)    cardEl.style.display    = "";
        if (resetBtnEl) resetBtnEl.textContent = "Reset";
    }

    const modal = _getUserProfileModalInstance();
    if (modal) modal.show();
}

function closeUserProfileModal() {
    const modal = _getUserProfileModalInstance();
    if (modal) modal.hide();
}

function applyUserFormMode(mode) {
    // Set mode immediately so refreshAllAdministrativeTables can read it
    document.getElementById("sec-adm-users").dataset.userMode = mode;

    // Reset form to blank state (except explicit dropdowns set below)
    const profileForm = document.getElementById("frm-adm-user-profile");
    if (profileForm) profileForm.reset();
    document.getElementById("usr-active").checked = true;
    const _mMsg = document.getElementById("usr-pwd-mismatch-msg");
    if (_mMsg) _mMsg.style.display = "none";
    removeCatalogDeleteButton("btn-dynamic-usr-delete");

    // --- Card header caption ---
    const cardHeader = document.querySelector("#sec-adm-users .card-header");
    if (cardHeader) cardHeader.textContent = mode === "CUSTOMER" ? "Add New Customer Profile" : "Add New Staff User Profile";

    // --- Leave-blank hint ---
    const hintEl = document.querySelector("#sec-adm-users .form-text.text-muted.small");
    if (hintEl) hintEl.textContent = mode === "CUSTOMER"
        ? "Leave blank when registering a new Customer."
        : "Leave blank when registering a new Staff member.";

    // --- usr-role dropdown: show only relevant option, set value, disable ---
    const roleSelect = document.getElementById("usr-role");
    if (roleSelect) {
        Array.from(roleSelect.options).forEach(opt => {
            if (opt.value === "") return; // keep placeholder
            opt.hidden = true;
        });
        if (mode === "CUSTOMER") {
            const custOpt = roleSelect.querySelector("option[value='CUSTOMER']");
            if (custOpt) { custOpt.hidden = false; }
            roleSelect.value = "CUSTOMER";
            roleSelect.disabled = true;
        } else {
            // MANAGER mode: show MANAGER and STAFF, let user choose, default MANAGER
            ["MANAGER","STAFF"].forEach(v => {
                const opt = roleSelect.querySelector(`option[value='${v}']`);
                if (opt) opt.hidden = false;
            });
            roleSelect.value = "MANAGER";
            roleSelect.disabled = false;  // user can choose MANAGER or STAFF
        }
    }

    // --- Password fields: hide for CUSTOMER, show & relabel for MANAGER/STAFF ---
    const pwdRow = document.getElementById("usr-password")?.closest(".row");
    const pwdField    = document.getElementById("usr-password");
    const confPwdField= document.getElementById("usr-confirm-password");
    const pwdLabel    = pwdField?.previousElementSibling;
    const confPwdLabel= confPwdField?.previousElementSibling;
    if (mode === "CUSTOMER") {
        if (pwdRow) pwdRow.style.display = "none";
    } else {
        if (pwdRow) pwdRow.style.display = "";
        if (pwdLabel)    pwdLabel.textContent    = "Sign-In Password";
        if (confPwdLabel) confPwdLabel.textContent = "Confirm Password";
        // Apply mandatory/optional state based on currently selected role (default MANAGER)
        _updatePasswordRequirementForRole(roleSelect ? roleSelect.value : "MANAGER");
    }

    // --- Age and Distance: hide for MANAGER/STAFF, show for CUSTOMER ---
    const ageEl  = document.getElementById("usr-age")?.closest(".col-md-6");
    const distEl = document.getElementById("usr-distance-wrapper")?.closest(".col-md-6");
    if (mode === "MANAGER") {
        if (ageEl)  ageEl.style.display  = "none";
        if (distEl) distEl.style.display = "none";
    } else {
        if (ageEl)  ageEl.style.display  = "";
        if (distEl) distEl.style.display = "";
    }

    // --- Email: mandatory for MANAGER, optional for STAFF and CUSTOMER ---
    const emailEl    = document.getElementById("usr-email");
    const emailLabel = document.getElementById("lbl-usr-email");
    if (mode === "MANAGER") {
        if (emailEl)    { emailEl.required = true;  emailEl.placeholder = "client@domain.com (Mandatory for Manager)"; }
        if (emailLabel) emailLabel.textContent = "Email Address";
    } else {
        if (emailEl)    { emailEl.required = false; emailEl.placeholder = "client@domain.com (Mandatory for Manager)"; }
        if (emailLabel) emailLabel.textContent = "Email Address [Optional]";
    }

    // --- Registration Fee and Date: show for CUSTOMER only ---
    const regFeeWrapper = document.getElementById("usr-reg-fee-wrapper");
    if (regFeeWrapper) regFeeWrapper.style.display = mode === "CUSTOMER" ? "" : "none";

    // --- Populate usr-select-existing with role filter ---
    _repopulateUserSelectExisting(mode);

    // --- Refresh the users table with role filter ---
    _refreshUserTableForMode(mode);
}

async function _repopulateUserSelectExisting(mode) {
    if (!activeSessionUser) return;
    const ownerId = activeSessionUser.ownerUserNo;
    const userProfileSelect = document.getElementById("usr-select-existing");
    if (!userProfileSelect) return;

    let usersQuery;
    if (mode === "CUSTOMER") {
        usersQuery = query(collection(db, "users"),
            where("ownerUserNo", "==", ownerId),
            where("role", "==", "CUSTOMER"));
    } else {
        usersQuery = query(collection(db, "users"),
            where("ownerUserNo", "==", ownerId),
            where("role", "in", ["MANAGER", "STAFF"]));
    }
    const usersSnap = await getDocs(usersQuery);
    userProfileSelect.innerHTML = `<option value="">-- Creating a Brand New Profile --</option>`;
    usersSnap.forEach(d => {
        const data = d.data();
        userProfileSelect.innerHTML += `<option value="${data.userNo}">${data.name} — ${data.role} (ID: ${data.userNo})</option>`;
    });
    userProfileSelect._allOptions = Array.from(userProfileSelect.options);
}

async function _refreshUserTableForMode(mode) {
    if (!activeSessionUser) return;
    const ownerId = activeSessionUser.ownerUserNo;
    const usrTbody = document.getElementById("tbl-adm-users");
    if (!usrTbody) return;

    let usrQ;
    if (mode === "CUSTOMER") {
        usrQ = query(collection(db, "users"),
            where("ownerUserNo", "==", ownerId),
            where("role", "==", "CUSTOMER"));
    } else {
        usrQ = query(collection(db, "users"),
            where("ownerUserNo", "==", ownerId),
            where("role", "in", ["MANAGER", "STAFF"]));
    }
    const usrSnap = await getDocs(usrQ);
    usrTbody.innerHTML = "";
    usrSnap.forEach(d => {
        const data = d.data();
        const tr = document.createElement("tr");
        tr.innerHTML = `<td>#${data.userNo}</td><td><span class="badge bg-secondary text-uppercase">${data.role}</span></td><td><strong>${data.name}</strong></td><td>${data.phone || "—"}</td><td>${data.email || "—"}</td><td><span class="badge ${data.active?'bg-success':'bg-secondary'}">${data.active?'Active Card':'Archived'}</span></td><td>-</td>`;
        usrTbody.appendChild(tr);
    });
}

// =========================================================================
// Change Password
// =========================================================================
async function processChangePasswordSubmission(e) {
    e.preventDefault();
    const oldPwd     = document.getElementById("chpwd-old").value;
    const newPwd     = document.getElementById("chpwd-new").value;
    const confirmPwd = document.getElementById("chpwd-confirm").value;
    const mismatchEl = document.getElementById("chpwd-mismatch-msg");

    // Match new vs confirm
    if (newPwd !== confirmPwd) {
        if (mismatchEl) mismatchEl.style.display = "block";
        document.getElementById("chpwd-confirm").focus();
        return;
    }
    if (mismatchEl) mismatchEl.style.display = "none";

    if (!newPwd.trim()) return alert("Validation Error: New Password cannot be empty.");

    try {
        // Build query to find the logged-in user's document
        let q;
        if (activeSessionUser.role === "MANAGER") {
            // Match both ownerUserNo and userNo for MANAGER
            q = query(collection(db, "users"),
                where("ownerUserNo", "==", activeSessionUser.ownerUserNo),
                where("userNo",      "==", activeSessionUser.userNo),
                where("role",        "==", "MANAGER"));
        } else {
            q = query(collection(db, "users"),
                where("userNo", "==", activeSessionUser.userNo));
        }
        const snap = await getDocs(q);
        if (snap.empty) return alert("Error: Could not locate your user record.");

        const userDoc  = snap.docs[0];
        const userData = userDoc.data();

        // Verify old password
        if (userData.password !== oldPwd)
            return alert("Error: Old Password is incorrect.");

        // Update password
        await updateDoc(userDoc.ref, { password: newPwd });
        alert("✅ Password updated successfully.");
        document.getElementById("frm-change-password").reset();
        if (mismatchEl) mismatchEl.style.display = "none";

    } catch(err) { await handleTelemetryAlert("Change Password Submission", err); }
}

// =========================================================================
// Allot Form — Existing Active Package Detection & UI
// =========================================================================
let _allotExistingPacks = [];   // array of active allotted pack data objects matching the condition
let _allotExistingIdx   = 0;   // current index being displayed

function resetAllotExistingPackUI() {
    _allotExistingPacks = [];
    _allotExistingIdx = 0;

    // Re-enable pack-select
    const packSel = document.getElementById("allot-pack-select");
    if (packSel) packSel.removeAttribute("disabled");

    // (a) Restore allot-pack-search visibility
    const packSearch = document.getElementById("allot-pack-search");
    if (packSearch) packSearch.style.display = "";

    // (a) Remove the reason text element if it exists
    const reasonEl = document.getElementById("allot-pack-reason");
    if (reasonEl) reasonEl.remove();

    // Show Sell, hide Modify
    const sellBtn = document.getElementById("btn-allot-sell");
    const modBtn  = document.getElementById("btn-allot-modify");
    if (sellBtn) { sellBtn.classList.remove("d-none"); sellBtn.disabled = false; }
    if (modBtn)  modBtn.classList.add("d-none");

    // Hide extra fields, alert, nav
    const extraEl = document.getElementById("allot-existing-extra-fields");
    if (extraEl) extraEl.style.display = "none";
    const alertEl = document.getElementById("allot-existing-alert");
    if (alertEl) {
        alertEl.style.display = "none";
    }
    const navEl = document.getElementById("allot-existing-nav");
    if (navEl) navEl.style.display = "none";
    ["btn-allot-prev","btn-allot-next","allot-existing-nav-label"].forEach(id => {
        const el = document.getElementById(id);
        if (el) { el.style.display = "none"; if (el.tagName === "BUTTON") el.disabled = true; else el.textContent = ""; }
    });

    // Clear extra field values and restore their col visibility
    const opEl = document.getElementById("allot-original-price");
    if (opEl) {
        opEl.value = "";
        const opCol = opEl.closest(".col-md-4");
        if (opCol) opCol.style.display = "";
    }
    const rbEl = document.getElementById("allot-remaining-balance");
    if (rbEl) {
        rbEl.value = "";
        const rbCol = rbEl.closest(".col-md-4");
        if (rbCol) rbCol.style.display = "";
    }
    const ubEl = document.getElementById("allot-unpaid-balance-field");
    if (ubEl) {
        ubEl.value = "";
        const ubCol = ubEl.closest(".col-md-4");
        if (ubCol) ubCol.style.display = "";
    }
    const avEl = document.getElementById("allot-addl-amt-visits");
    if (avEl) { avEl.value = ""; const avCol = avEl.closest(".col-md-4"); if (avCol) avCol.style.display = ""; }

    // Clear pack preview
    const previewEl = document.getElementById("allot-pack-preview");
    if (previewEl) previewEl.style.display = "none";
    const discEl = document.getElementById("allot-sold-discount");
    if (discEl) discEl.textContent = "";
    const unpaidEl = document.getElementById("allot-unpaid-display");
    if (unpaidEl) unpaidEl.textContent = "";
    allotCurrentPackTotalAmount = 0;
}

// Explicitly hides the three extra UI groups when no active package is found for the customer
function hideAllotExtraUIElements() {
    // Hide both extra-field rows and clear all values within them
    ["allot-extra-row-1", "allot-extra-row-2"].forEach(rowId => {
        const row = document.getElementById(rowId);
        if (row) row.style.display = "none";
    });
    ["allot-original-price","allot-remaining-balance","allot-unpaid-balance-field","allot-addl-amt-visits"].forEach(id => {
        const el = document.getElementById(id);
        if (el) { el.value = ""; delete el.dataset.sumAddlAmt; }
    });
    // Hide allot-existing-nav and its contents
    const navEl = document.getElementById("allot-existing-nav");
    if (navEl) navEl.style.display = "none";
    ["btn-allot-prev","btn-allot-next","allot-existing-nav-label"].forEach(id => {
        const el = document.getElementById(id);
        if (el) { el.style.display = "none"; if (el.tagName === "BUTTON") el.disabled = true; else el.textContent = ""; }
    });
    // Also ensure the extra-fields wrapper row is hidden
    const extraEl = document.getElementById("allot-existing-extra-fields");
    if (extraEl) extraEl.style.display = "none";
}

async function handleAllotCustomerSelectChange() {
    const custNo = document.getElementById("allot-customer-select").value;
    // Always reset existing-pack UI first (preserves customer selection)
    resetAllotExistingPackUI();
    // Also clear pack-related fields
    const packSel = document.getElementById("allot-pack-select");
    if (packSel) packSel.value = "";
    const startEl = document.getElementById("allot-start-date");
    if (startEl) startEl.value = "";
    const expiryEl = document.getElementById("allot-expiry-date");
    if (expiryEl) expiryEl.value = "";
    const soldEl = document.getElementById("allot-sold-price");
    if (soldEl) soldEl.value = "";
    const amtEl = document.getElementById("allot-amount-received");
    if (amtEl) amtEl.value = "";

    if (!custNo || !activeSessionUser) return;

    try {
        const today = new Date().toISOString().split("T")[0];
        const q = query(
            collection(db, "customerServicePacks"),
            where("ownerUserNo", "==", activeSessionUser.ownerUserNo),
            where("customerNo", "==", custNo),
            where("packType", "==", "Type3")
        );
        const snap = await getDocs(q);
        if (snap.empty) { hideAllotExtraUIElements(); return; }

        // Filter packs that are "in progress":
        // unpaidBalance > 0 OR
        // (expiryDate not null AND expiryDate >= today AND remainingBalance > 0) OR
        // (expiryDate is null AND remainingBalance > 0)
        const activePacks = [];
        for (const d of snap.docs) {
            const p = d.data();
            const unpaid = Number(p.unpaidBalance || 0);
            const remaining = Number(p.remainingBalance || 0);
            const expiry = p.expiryDate || null;

            const condition =
                unpaid > 0 ||
                (expiry !== null && expiry >= today && remaining > 0) ||
                (expiry === null && remaining > 0);

            if (condition) {
                // Compute total amountReceived: pack amountReceived + sum of addlAmtReceived in logs
                const logsQ = query(
                    collection(db, "serviceUtilizationLogs"),
                    where("ownerUserNo", "==", activeSessionUser.ownerUserNo),
                    where("allotId", "==", p.allotId),
                    where("customerNo", "==", custNo)
                );
                const logsSnap = await getDocs(logsQ);
                let sumAddl = 0;
                logsSnap.forEach(ld => { sumAddl += Number(ld.data().addlAmtReceived || 0); });
                activePacks.push({ ...p, _totalAmtReceived: Number(p.amountReceived || 0) + sumAddl, _reason: buildAllotExistingReason(p, today) });
            }
        }

        if (activePacks.length === 0) { hideAllotExtraUIElements(); return; }

        // There are in-progress packages — block new allotment
        _allotExistingPacks = activePacks;
        _allotExistingIdx = 0;
        showAllotExistingPackAtIndex(0);

    } catch (err) {
        await handleTelemetryAlert("Allot Customer Select Change", err);
    }
}

function buildAllotExistingReason(p, today) {
    const reasons = [];
    const unpaid = Number(p.unpaidBalance || 0);
    const remaining = Number(p.remainingBalance || 0);
    const expiry = p.expiryDate || null;
    if (unpaid > 0) reasons.push(`Unpaid Balance: ₹${unpaid.toLocaleString("en-IN")}`);
    if (expiry !== null && expiry >= today && remaining > 0) reasons.push(`Package Not Expired (Expiry: ${expiry})`);
    if (expiry === null && remaining > 0) reasons.push(`No Expiry Set, Balance Remaining`);
    return reasons.join(" | ");
}

function showAllotExistingPackAtIndex(idx) {
    const p = _allotExistingPacks[idx];
    if (!p) return;

    // Only pack-select is disabled (cannot change package); all price/date fields remain editable
    const packSel = document.getElementById("allot-pack-select");
    if (packSel) packSel.setAttribute("disabled", "true");

    // (a) Hide allot-pack-search when in existing-pack mode
    const packSearch = document.getElementById("allot-pack-search");
    if (packSearch) packSearch.style.display = "none";

    // Populate fields from existing pack
    if (packSel) {
        // Try to select the matching option
        let found = false;
        for (const opt of packSel.options) {
            if (opt.value === p.packName) { packSel.value = p.packName; found = true; break; }
        }
        if (!found) {
            // Add a temporary option
            const tempOpt = document.createElement("option");
            tempOpt.value = p.packName;
            tempOpt.textContent = p.packName;
            packSel.insertBefore(tempOpt, packSel.firstChild);
            packSel.value = p.packName;
        }
    }

    // (a) Inject reason text below allot-pack-select (create or reuse dedicated element)
    let reasonEl = document.getElementById("allot-pack-reason");
    if (!reasonEl) {
        reasonEl = document.createElement("div");
        reasonEl.id = "allot-pack-reason";
        reasonEl.className = "mt-1 small";
        // Insert it right after the allot-pack-select's parent col
        const packSelParent = packSel ? packSel.closest(".col-md-6") : null;
        if (packSelParent) packSelParent.appendChild(reasonEl);
    }
    if (reasonEl) {
        reasonEl.style.display = "block";
        reasonEl.innerHTML = `<span class="text-muted">Reason: </span><span class="text-dark">${p._reason}</span> <strong class="text-success">(You may update Expiry Date here, if desired)</strong>`;
    }

    const soldEl = document.getElementById("allot-sold-price");
    if (soldEl) soldEl.value = p.soldPrice !== undefined ? p.soldPrice : "";

    // [1b-i] Populate amountReceived from customerServicePacks record (discard any prior UI value)
    const amtEl = document.getElementById("allot-amount-received");
    if (amtEl) amtEl.value = p.amountReceived !== undefined ? p.amountReceived : "";

    const startEl = document.getElementById("allot-start-date");
    if (startEl) startEl.value = p.startDate || "";
    const expiryEl = document.getElementById("allot-expiry-date");
    if (expiryEl) {
        expiryEl.value = p.expiryDate || "";
        expiryEl.removeAttribute("readonly");
    }

    // [1b-ii] Change Reset button caption to "Cancel" while in modify mode
    const resetBtn = document.getElementById("btn-reset-allot");
    if (resetBtn) resetBtn.textContent = "Cancel";

    // Show extra field rows [1a]
    const row1 = document.getElementById("allot-extra-row-1");
    if (row1) row1.style.display = "";
    const row2 = document.getElementById("allot-extra-row-2");
    if (row2) row2.style.display = "";

    // Populate extra fields
    const opEl = document.getElementById("allot-original-price");
    if (opEl) opEl.value = p.totalAmount !== undefined ? `₹${Number(p.totalAmount).toLocaleString("en-IN")}` : "";
    const rbEl = document.getElementById("allot-remaining-balance");
    if (rbEl) rbEl.value = p.remainingBalance !== undefined ? p.remainingBalance : "";

    // Amt Recvd in Visits — populate from serviceUtilizationLogs
    const avEl = document.getElementById("allot-addl-amt-visits");
    if (avEl) {
        avEl.value = "Loading…";
        getDocs(query(collection(db, "serviceUtilizationLogs"),
            where("ownerUserNo", "==", activeSessionUser.ownerUserNo),
            where("customerNo",  "==", p.customerNo),
            where("allotId",     "==", p.allotId)
        )).then(logsSnap => {
            let sum = 0;
            logsSnap.forEach(d => { sum += Number(d.data().addlAmtReceived || 0); });
            avEl.value = `₹${sum.toLocaleString("en-IN")}`;
            avEl.dataset.sumAddlAmt = sum;
        }).catch(() => { avEl.value = "—"; avEl.dataset.sumAddlAmt = 0; });
    }

    // Unpaid Balance
    const ubEl = document.getElementById("allot-unpaid-balance-field");
    if (ubEl) ubEl.value = p.unpaidBalance !== undefined ? `₹${Number(p.unpaidBalance).toLocaleString("en-IN")}` : "";

    // (b) Alert message: updated text — statically placed above Select Customer in HTML
    const alertEl = document.getElementById("allot-existing-alert");
    if (alertEl) {
        alertEl.style.display = "block";
        alertEl.innerHTML = `⚠️ <strong>Some Packages Already in Progress (Details below), Cannot allot another Package</strong>`;
    }

    // Nav buttons — shown only when more than one in-progress pack exists
    const navEl    = document.getElementById("allot-existing-nav");
    const navLabel = document.getElementById("allot-existing-nav-label");
    const prevBtn  = document.getElementById("btn-allot-prev");
    const nextBtn  = document.getElementById("btn-allot-next");
    if (navEl) {
        if (_allotExistingPacks.length > 1) {
            navEl.style.display = "flex";
            if (navLabel) { navLabel.textContent = `Package ${idx + 1} of ${_allotExistingPacks.length}`; navLabel.style.display = ""; }
            if (prevBtn)  { prevBtn.style.display = "";  prevBtn.disabled  = (idx === 0); }
            if (nextBtn)  { nextBtn.style.display = "";  nextBtn.disabled  = (idx === _allotExistingPacks.length - 1); }
        } else {
            navEl.style.display = "none";
            if (navLabel) { navLabel.textContent = ""; navLabel.style.display = "none"; }
            if (prevBtn)  { prevBtn.style.display  = "none"; prevBtn.disabled  = true; }
            if (nextBtn)  { nextBtn.style.display  = "none"; nextBtn.disabled  = true; }
        }
    }

    // Show Modify, hide Sell
    const sellBtn = document.getElementById("btn-allot-sell");
    const modBtn  = document.getElementById("btn-allot-modify");
    if (sellBtn) { sellBtn.classList.add("d-none"); sellBtn.disabled = true; }
    if (modBtn)  modBtn.classList.remove("d-none");

    // Update discount/balance display
    allotCurrentPackTotalAmount = Number(p.totalAmount || 0);
    updateAllotmentDiscountAndBalance();

    // Show pack preview if pack data is in cache, then HIDE it (d) — not shown in existing-pack mode
    const packCacheData = allotPacksCache.get(p.packName);
    if (packCacheData) {
        handleAllotPackSelectChange();
    }
    // (d) Hide "📦 Package Contents" panel in existing-pack mode
    const previewElHide = document.getElementById("allot-pack-preview");
    if (previewElHide) previewElHide.style.display = "none";
}

function navigateAllotExistingPack(direction) {
    const newIdx = _allotExistingIdx + direction;
    if (newIdx < 0 || newIdx >= _allotExistingPacks.length) return;
    _allotExistingIdx = newIdx;
    showAllotExistingPackAtIndex(_allotExistingIdx);
}

async function handleAllotModifyClick() {
    const p = _allotExistingPacks[_allotExistingIdx];
    if (!p) return;

    const newExpiry    = document.getElementById("allot-expiry-date").value;
    const newSoldPrice = parseFloat(document.getElementById("allot-sold-price").value);
    const newAmtRcvd   = parseFloat(document.getElementById("allot-amount-received").value) || 0;
    const newStartDate = document.getElementById("allot-start-date").value;
    const origPrice    = parseFloat(document.getElementById("allot-original-price")?.value) || 0;

    // Old values from the currently loaded pack record
    const oldSoldPrice = parseFloat(p.soldPrice || 0);
    const oldAmtRcvd   = parseFloat(p.amountReceived || 0);

    // sumAddlAmt cached on the field when pack was loaded (avoids extra Firestore call)
    const avEl      = document.getElementById("allot-addl-amt-visits");
    const sumAddlAmt = avEl ? parseFloat(avEl.dataset.sumAddlAmt || 0) : 0;

    // ── Hard validations (block update) ──────────────────────────────────────
    if (isNaN(newSoldPrice) || newSoldPrice <= 0)
        return alert("Validation Error: Selling Price must be a positive number.");
    if (newAmtRcvd < 0)
        return alert("Validation Error: Amount Received cannot be negative.");
    if (!newStartDate)
        return alert("Validation Error: Activation Date is required.");

    // (b) Expiry cannot be before Start Date — hard block
    if (newExpiry && newStartDate && newExpiry < newStartDate)
        return alert("Validation Error: Expiry Date cannot be BEFORE Activation Date.");

    // (c) Start Date cannot be after earliest visit date — hard block
    const logsForDates = await getDocs(query(
        collection(db, "serviceUtilizationLogs"),
        where("ownerUserNo", "==", activeSessionUser.ownerUserNo),
        where("customerNo",  "==", p.customerNo),
        where("allotId",     "==", p.allotId)
    ));
    if (!logsForDates.empty) {
        const visitDates = [];
        logsForDates.forEach(d => { const vd = d.data().visitDate; if (vd) visitDates.push(vd); });
        if (visitDates.length > 0) {
            const minVisitDate = visitDates.sort()[0];
            if (newStartDate > minVisitDate)
                return alert(`Validation Error: Activation Date cannot be AFTER Visit Date (earliest visit: ${minVisitDate}).`);
        }
    }

    // ── Soft validations (warn, allow update after confirmation) ─────────────
    const warnings = [];
    const totalReceived = newAmtRcvd + sumAddlAmt;

    // (a-1) Selling Price < Amount Received
    if (newSoldPrice < newAmtRcvd)
        warnings.push("⚠️ Selling Price cannot be LESS than Amount Received.");

    // (a-2) Selling Price > Original Price
    if (origPrice > 0 && newSoldPrice > origPrice)
        warnings.push("⚠️ Selling Price cannot be MORE than Original Price.");

    // (d) Total receipts (amountReceived + visit addl amts) > Selling Price
    if (totalReceived > newSoldPrice)
        warnings.push(`⚠️ Amount Received (₹${newAmtRcvd.toLocaleString("en-IN")}) including visit collections (₹${sumAddlAmt.toLocaleString("en-IN")}) totals ₹${totalReceived.toLocaleString("en-IN")}, which cannot be more than Selling Price (₹${newSoldPrice.toLocaleString("en-IN")}).`);

    if (warnings.length > 0) {
        const proceed = confirm(warnings.join("\n\n") + "\n\nDo you still want to save these changes?");
        if (!proceed) return;
    }

    // ── New balance formulas ──────────────────────────────────────────────────
    // remainingBalance += newSoldPrice - oldSoldPrice
    const oldRemainingBalance = parseFloat(p.remainingBalance || 0);
    const newRemainingBalance = oldRemainingBalance + (newSoldPrice - oldSoldPrice);

    // unpaidBalance += oldAmtRcvd - newAmtRcvd
    const oldUnpaidBalance = parseFloat(p.unpaidBalance || 0);
    const newUnpaidBalance = Math.max(0, oldUnpaidBalance + (oldAmtRcvd - newAmtRcvd));

    // ── Perform the update ────────────────────────────────────────────────────
    try {
        const q = query(
            collection(db, "customerServicePacks"),
            where("ownerUserNo", "==", activeSessionUser.ownerUserNo),
            where("allotId",     "==", p.allotId),
            where("customerNo",  "==", p.customerNo)
        );
        const snap = await getDocs(q);
        if (snap.empty) return alert("Error: Could not locate the package record to update.");

        const updatePayload = {
            expiryDate:       newExpiry         || null,
            soldPrice:        newSoldPrice,
            amountReceived:   newAmtRcvd,
            startDate:        newStartDate,
            unpaidBalance:    newUnpaidBalance,
            // Note: remainingBalance is NOT updated here — it is only adjusted by visit deductions
        };
        await updateDoc(snap.docs[0].ref, updatePayload);
        alert("✅ Package record updated successfully.");

        // Refresh local in-memory cache
        _allotExistingPacks[_allotExistingIdx] = {
            ...p,
            expiryDate:       newExpiry         || null,
            soldPrice:        newSoldPrice,
            amountReceived:   newAmtRcvd,
            startDate:        newStartDate,
            unpaidBalance:    newUnpaidBalance,
        };

        // Refresh UI balance fields
        const ubEl2 = document.getElementById("allot-unpaid-balance-field");
        if (ubEl2) ubEl2.value = `₹${newUnpaidBalance.toLocaleString("en-IN")}`;

    } catch (err) {
        await handleTelemetryAlert("Allot Modify Update", err);
    }
}

async function handleAllotPackSelectChange() {
    const packName = document.getElementById("allot-pack-select").value;
    const previewEl = document.getElementById("allot-pack-preview");
    const detailsEl = document.getElementById("allot-pack-preview-details");
    const soldPriceEl = document.getElementById("allot-sold-price");
    const discountEl = document.getElementById("allot-sold-discount");
    const unpaidEl = document.getElementById("allot-unpaid-display");

    allotCurrentPackTotalAmount = 0;
    if (previewEl) previewEl.style.display = "none";
    if (soldPriceEl) soldPriceEl.value = "";
    if (discountEl) discountEl.textContent = "";
    if (unpaidEl) unpaidEl.textContent = "";

    if (!packName) return;

    const pack = allotPacksCache.get(packName);
    if (!pack) return;

    allotCurrentPackTotalAmount = Number(pack.totalAmount) || 0;
    const offerPrice = pack.offerPrice !== undefined ? Number(pack.offerPrice) : null;
    const serviceCount = pack.subServicesArray ? pack.subServicesArray.length : 0;

    let discountBadge = "";
    if (offerPrice !== null && allotCurrentPackTotalAmount > 0) {
        const disc = ((allotCurrentPackTotalAmount - offerPrice) / allotCurrentPackTotalAmount * 100);
        if (disc > 0) discountBadge = ` <span class="badge bg-success">${disc.toFixed(1)}% off</span>`;
    }

    detailsEl.innerHTML = `
        <div class="row g-2">
            <div class="col-6"><span class="text-muted">Total Services Price (₹):</span> <strong>₹${allotCurrentPackTotalAmount.toLocaleString("en-IN")}</strong></div>
            <div class="col-6"><span class="text-muted">Pack Offered Price (₹):</span> <strong>${offerPrice !== null ? "₹" + offerPrice.toLocaleString("en-IN") : "N/A"}${discountBadge}</strong></div>
            <div class="col-12"><span class="text-muted">Service Items ${pack.packType === "Type3" ? "NOT " : ""}Allowed in this Pack:</span> <strong>${serviceCount} item${serviceCount === 1 ? "" : "s"}</strong></div>
            <div class="col-12" id="allot-subservice-list"><span class="text-muted small">Loading items…</span></div>
        </div>`;
    previewEl.style.display = "block";

    if (soldPriceEl && offerPrice !== null) {
        soldPriceEl.value = offerPrice;
        updateAllotmentDiscountAndBalance();
    }

    // (a) Fetch and display individual service items with serviceName join
    if (pack.subServicesArray && pack.subServicesArray.length > 0) {
        try {
            // Fetch subservices
            const ssResults = await Promise.all(pack.subServicesArray.map(code => {
                const q = query(collection(db, "subServices"),
                    where("ownerUserNo", "==", activeSessionUser.ownerUserNo),
                    where("subServiceCode", "==", code));
                return getDocs(q);
            }));

            // Build serviceCode → serviceName lookup (same join as container-utilize-subservices)
            const srvNameMap = new Map();
            let srvSnap = await getDocs(query(collection(db, "services"), where("ownerUserNo", "==", activeSessionUser.ownerUserNo)));
            if (srvSnap.empty) srvSnap = await getDocs(query(collection(db, "services"), where("ownerUserNo", "==", "000")));
            srvSnap.forEach(d => { const s = d.data(); srvNameMap.set(s.serviceCode, s.serviceName); });

            let listHtml = `<div class="mt-1"><span class="text-muted fw-bold small">${pack.packType === "Type3" ? "Excluded" : "Included"} Services:</span><ul class="mb-0 mt-1 ps-3">`;
            ssResults.forEach(snap => {
                if (!snap.empty) {
                    const ss = snap.docs[0].data();
                    const parentName = srvNameMap.get(ss.serviceCode) || "";
                    const displayName = parentName ? `${ss.subServiceName} (${parentName})` : ss.subServiceName;
                    listHtml += `<li class="small">${displayName} <span class="text-success fw-bold">₹${Number(ss.rate).toLocaleString("en-IN")}</span></li>`;
                }
            });
            listHtml += `</ul></div>`;
            const listEl = document.getElementById("allot-subservice-list");
            if (listEl) listEl.innerHTML = listHtml;
        } catch (e) {
            const listEl = document.getElementById("allot-subservice-list");
            if (listEl) listEl.innerHTML = `<span class="text-muted small">Could not load service items.</span>`;
        }
    } else {
        const listEl = document.getElementById("allot-subservice-list");
        if (listEl) listEl.innerHTML = "";
    }
}

function updateAllotmentDiscountAndBalance() {
    const soldPriceEl = document.getElementById("allot-sold-price");
    const amtReceivedEl = document.getElementById("allot-amount-received");
    const discountEl = document.getElementById("allot-sold-discount");
    const unpaidEl = document.getElementById("allot-unpaid-display");
    if (!soldPriceEl || !discountEl || !unpaidEl) return;

    const soldPrice = parseFloat(soldPriceEl.value);
    const amtReceived = parseFloat(amtReceivedEl ? amtReceivedEl.value : "") || 0;

    if (!isNaN(soldPrice) && allotCurrentPackTotalAmount > 0) {
        const discount = ((allotCurrentPackTotalAmount - soldPrice) / allotCurrentPackTotalAmount * 100);
        if (discount > 0) {
            discountEl.textContent = `${discount.toFixed(1)}% off`;
            discountEl.className = "fw-bold small text-nowrap text-success";
        } else if (discount < 0) {
            discountEl.textContent = `${Math.abs(discount).toFixed(1)}% above list`;
            discountEl.className = "fw-bold small text-nowrap text-danger";
        } else {
            discountEl.textContent = "No discount";
            discountEl.className = "fw-bold small text-nowrap text-muted";
        }
    } else {
        discountEl.textContent = "";
    }

    if (!isNaN(soldPrice)) {
        const unpaid = soldPrice - amtReceived;
        if (unpaid > 0) {
            unpaidEl.textContent = `₹${unpaid.toLocaleString("en-IN")} unpaid`;
            unpaidEl.className = "fw-bold small text-nowrap text-danger";
        } else if (unpaid < 0) {
            unpaidEl.textContent = `₹${Math.abs(unpaid).toLocaleString("en-IN")} overpaid`;
            unpaidEl.className = "fw-bold small text-nowrap text-warning";
        } else {
            unpaidEl.textContent = "Fully paid ✓";
            unpaidEl.className = "fw-bold small text-nowrap text-success";
        }
    } else {
        unpaidEl.textContent = "";
    }
}

async function processAllotmentFormSubmission(e) {
    e.preventDefault();
    const cust = document.getElementById("allot-customer-select").value;
    const templatePackName = document.getElementById("allot-pack-select").value;
    const start = document.getElementById("allot-start-date").value;
    const expiry = document.getElementById("allot-expiry-date").value;
    const soldPrice = parseFloat(document.getElementById("allot-sold-price").value) || 0;
    const amountReceived = parseFloat(document.getElementById("allot-amount-received") ? document.getElementById("allot-amount-received").value : "") || 0;
    const unpaidBalance = Math.max(0, soldPrice - amountReceived);

    if (!cust || !templatePackName) return alert("System Configuration Error: Please ensure you select both a valid client and an active package setup template.");

    if (expiry && start && expiry < start)
        return alert("Validation Error: Expiration Date cannot be before the Activation Date.");

    try {
        const q = query(collection(db, "commonServicePacks"), where("ownerUserNo", "==", activeSessionUser.ownerUserNo), where("packName", "==", templatePackName));
        const res = await getDocs(q);
        if (res.empty) return alert("Activation Blocked: Could not find the selected core packaging model blueprint rules.");
        const templateData = res.docs[0].data();

        // (c) allotId: <ownerUserNo>_APCK_<first3LettersOfPackName><serial>
        //     serial = max serial already used for THIS packName by THIS owner + 1
        const packPrefix = templatePackName.replace(/\s+/g, "").substring(0, 3).toUpperCase();
        const existingAllotsQ = query(collection(db, "customerServicePacks"),
            where("ownerUserNo", "==", activeSessionUser.ownerUserNo),
            where("packName",    "==", templatePackName));
        const existingAllotsSnap = await getDocs(existingAllotsQ);
        let maxPackSerial = 0;
        const packSerialPattern = new RegExp(`^${activeSessionUser.ownerUserNo}_APCK_${packPrefix}(\\d+)$`);
        existingAllotsSnap.forEach(d => {
            const m = (d.data().allotId || "").match(packSerialPattern);
            if (m) { const n = parseInt(m[1], 10); if (!isNaN(n) && n > maxPackSerial) maxPackSerial = n; }
        });
        const allotId = `${activeSessionUser.ownerUserNo}_APCK_${packPrefix}${maxPackSerial + 1}`;

        // (d) doc id: <ownerUserNo>_ALLOT_<num>
        //     num = max existing serial across ALL allotments for this owner + 1
        const allOwnerAllotsQ = query(collection(db, "customerServicePacks"),
            where("ownerUserNo", "==", activeSessionUser.ownerUserNo));
        const allOwnerAllotsSnap = await getDocs(allOwnerAllotsQ);
        let maxAllotSerial = 0;
        const allotDocPattern = new RegExp(`^${activeSessionUser.ownerUserNo}_ALLOT_(\\d+)$`);
        allOwnerAllotsSnap.forEach(d => {
            const m = d.id.match(allotDocPattern);
            if (m) { const n = parseInt(m[1], 10); if (!isNaN(n) && n > maxAllotSerial) maxAllotSerial = n; }
        });
        const docNum = maxAllotSerial + 1;
        const docId  = `${activeSessionUser.ownerUserNo}_ALLOT_${docNum}`;

        await setDoc(doc(db, "customerServicePacks", docId), {
            ownerUserNo: activeSessionUser.ownerUserNo, allotId: allotId, customerNo: cust,
            packName: templatePackName, packType: templateData.packType,
            // Type3: remainingBalance = totalAmount (customer avails services up to full value, discount is in price paid)
            // Type1/Type2: remainingBalance = soldPrice
            remainingBalance: templateData.packType === "Type3" ? Number(templateData.totalAmount) : soldPrice,
            totalAmount: Number(templateData.totalAmount),
            soldPrice: soldPrice, amountReceived: amountReceived, unpaidBalance: unpaidBalance,
            subServicesArray: templateData.subServicesArray || [],
            startDate: start, expiryDate: expiry || null, active: true, createdAt: new Date().toISOString()
        });

        alert("Success: Package has been successfully assigned and logged to this client profile account card.");
        document.getElementById("frm-allot-membership").reset();
        const _srch = document.getElementById("allot-customer-search");
        if (_srch) { _srch.value = ""; _srch.dispatchEvent(new Event("input")); }
        allotCurrentPackTotalAmount = 0;
        const previewEl = document.getElementById("allot-pack-preview");
        if (previewEl) previewEl.style.display = "none";
        const discEl = document.getElementById("allot-sold-discount");
        if (discEl) discEl.textContent = "";
        const unpaidEl = document.getElementById("allot-unpaid-display");
        if (unpaidEl) unpaidEl.textContent = "";
        loadWorkspaceDropdownMappings();
    } catch(err) { await handleTelemetryAlert("Customer Contract Assignment Frame", err); }
}

// =========================================================================
// Role Modification Ledger Access Subsystem
// =========================================================================
async function processAccessControlFormSubmission(e) {
    e.preventDefault();
    const targetRole = document.getElementById("access-target-role").value;
    const allowReadCommon = document.getElementById("rights-read-common").checked;
    const allowReadCustomer = document.getElementById("rights-read-customer").checked;
    const allowWrite = document.getElementById("rights-write-allowed").checked;

    try {
        const rightsDocId = `${activeSessionUser.ownerUserNo}_ACL_${targetRole}`;
        await setDoc(doc(db, "accessControlRights", rightsDocId), {
            ownerUserNo: activeSessionUser.ownerUserNo, targetRole: targetRole,
            allowReadCommonPacks: allowReadCommon, allowReadCustomerPacks: allowReadCustomer,
            allowWritePrivileges: allowWrite, updatedAt: new Date().toISOString()
        });

        const uniqueLogId = "ACL-LOG-" + Math.floor(100000 + Math.random() * 900000);
        await setDoc(doc(db, "accessLogs", `${activeSessionUser.ownerUserNo}_ACLLOG_${uniqueLogId}`), {
            logId: uniqueLogId, ownerUserNo: activeSessionUser.ownerUserNo, managerUserId: targetRole,
            rightChanged: "allowWritePrivileges", newValue: allowWrite, changedBy: activeSessionUser.role,
            changedAt: new Date().toISOString()
        });

        alert(`Success: Staff management work permissions modified for group level: ${targetRole}`);
    } catch (err) { await handleTelemetryAlert("Access System Framework Controller", err); }
}

// =========================================================================
// Service Consumption Terminal Functions
// =========================================================================
async function updateCustomerAllottedPacksDropdown() {
    const custNo = document.getElementById("utilize-customer-select").value;
    const packEl = document.getElementById("utilize-pack-select");
    if (!packEl) return;

    packEl.innerHTML = `<option value="">Synchronizing package history charts...</option>`;
    if (!custNo) {
        packEl.innerHTML = `<option value="">-- Select Client Profile Above First --</option>`;
        return;
    }

    try {
        const q = query(collection(db, "customerServicePacks"),
            where("ownerUserNo", "==", activeSessionUser.ownerUserNo),
            where("customerNo", "==", custNo),
            where("packType",   "==", "Type3"),
            where("active",     "==", true));
        const snap = await getDocs(q);
        
        packEl.innerHTML = `<option value="">-- Choose Package Ledger Account --</option>`;
        snap.forEach(d => {
            const data = d.data();
            if (Number(data.remainingBalance || 0) > 0) {
                packEl.innerHTML += `<option value="${data.allotId}">${data.packName} | Allot ID: ${data.allotId} (Remaining Balance: ${data.remainingBalance})</option>`;
            }
        });
    } catch (err) { await handleTelemetryAlert("Dynamic Dropdown Sync Loop", err); }
}

// Point (a): decide ownerUserNo to use in where clauses for utilize form
function _getUtilizeOwnerMatch() {
    if (!activeSessionUser) return null;
    return activeSessionUser.role === "OWNER"
        ? activeSessionUser.userNo
        : activeSessionUser.ownerUserNo;
}

// Load staff/manager/owner options for service-provider dropdown, sorted STAFF first then others by name
async function _loadStaffOptions() {
    if (_utilizeStaffOptions !== null) return _utilizeStaffOptions; // use cache
    const ownerMatch = _getUtilizeOwnerMatch();
    if (!ownerMatch) return [];
    try {
        const q = query(collection(db, "users"),
            where("ownerUserNo", "==", ownerMatch),
            where("role", "in", ["OWNER", "MANAGER", "STAFF"]));
        const snap = await getDocs(q);
        const staff = [], others = [];
        snap.forEach(d => {
            const u = d.data();
            const entry = { userNo: u.userNo, role: u.role, name: u.name };
            if (u.role === "STAFF") staff.push(entry);
            else others.push(entry);
        });
        staff.sort((a, b) => a.name.localeCompare(b.name));
        others.sort((a, b) => a.name.localeCompare(b.name));
        _utilizeStaffOptions = [...staff, ...others];
    } catch { _utilizeStaffOptions = []; }
    return _utilizeStaffOptions;
}

// Build the staff dropdown HTML string for a given subServiceCode
function _buildStaffDropdownHtml(subServiceCode) {
    const opts = (_utilizeStaffOptions || []).map(u =>
        `<option value="${u.userNo}" data-role="${u.role}">${u.name} (${u.role})</option>`
    ).join("");
    return `<select class="form-select form-select-sm ms-2 staff-provider-select" style="width:auto;min-width:150px;display:inline-block;" data-for-service="${subServiceCode}">
                <option value="">-- Assign Staff --</option>${opts}
            </select>`;
}

// Attach checkbox → show/hide staff dropdown handler
function _attachStaffDropdownHandler(chk) {
    chk.addEventListener("change", () => {
        const wrapper = chk.closest(".form-check");
        if (!wrapper) return;
        const existingSel = wrapper.querySelector(".staff-provider-select");
        if (chk.checked) {
            if (!existingSel) {
                wrapper.insertAdjacentHTML("beforeend", _buildStaffDropdownHtml(chk.value));
            }
        } else {
            if (existingSel) existingSel.remove();
        }
        updateUtilizeServicesTotal();
    });
}

async function renderUtilizeSubServicesCheckboxes() {
    const allotId = document.getElementById("utilize-pack-select").value;
    const container = document.getElementById("container-utilize-subservices");
    const financialEl = document.getElementById("utilize-pack-financial");
    const totalEl = document.getElementById("utilize-services-total");
    const newUnpaidEl = document.getElementById("utilize-new-unpaid-display");
    const addlAmtEl = document.getElementById("utilize-addl-amt-received");
    if (!container) return;

    const utilizeSrchBox = document.getElementById("utilize-subservices-search");
    if (utilizeSrchBox) utilizeSrchBox.value = "";

    container.innerHTML = "";
    if (financialEl) financialEl.style.display = "none";
    if (totalEl) { totalEl.style.display = "none"; totalEl.textContent = ""; }
    if (newUnpaidEl) newUnpaidEl.textContent = "";
    if (addlAmtEl) addlAmtEl.value = "0";
    utilizePrevUnpaidBalance = 0;
    if (!allotId) return;

    // Pre-load staff options (cached after first load)
    await _loadStaffOptions();

    try {
        const q = query(collection(db, "customerServicePacks"), where("ownerUserNo", "==", activeSessionUser.ownerUserNo), where("allotId", "==", allotId));
        const res = await getDocs(q);
        if (res.empty) return;
        const pData = res.docs[0].data();

        const soldPrice   = pData.soldPrice   !== undefined ? Number(pData.soldPrice)   : null;
        const totalAmount = pData.totalAmount  !== undefined ? Number(pData.totalAmount) : null;
        const remainingBalance = Number(pData.remainingBalance);
        const rawAmtReceived = pData.amountReceived !== undefined ? Number(pData.amountReceived) : 0;

        // 2b: amtReceived = amountReceived in pack + sum of all addlAmtReceived in logs
        const customerNo = document.getElementById("utilize-customer-select").value;
        const logsQ = query(collection(db, "serviceUtilizationLogs"),
            where("ownerUserNo", "==", activeSessionUser.ownerUserNo),
            where("allotId",     "==", allotId),
            where("customerNo",  "==", customerNo));
        const logsSnap = await getDocs(logsQ);
        let sumAddlPaid = 0;
        logsSnap.forEach(d => { sumAddlPaid += Number(d.data().addlAmtReceived || 0); });
        const amtReceived = rawAmtReceived + sumAddlPaid;

        // 2c: unpaidBalance = soldPrice - amtReceived (unpaid is against the price the pack was sold at)
        const unpaidBalance = Math.max(0, (soldPrice !== null ? soldPrice : 0) - amtReceived);
        utilizePrevUnpaidBalance = unpaidBalance;

        // (c) Discount % from (totalAmount - soldPrice)*100/totalAmount
        let discountPct = 0;
        if (totalAmount && totalAmount > 0 && soldPrice !== null) {
            discountPct = ((totalAmount - soldPrice) * 100) / totalAmount;
            if (discountPct < 0) discountPct = 0; // no negative discount shown
        }

        const today = new Date().toISOString().slice(0, 10);
        const isExhausted = remainingBalance <= 0;
        const isExpired   = pData.expiryDate && pData.expiryDate !== null && pData.expiryDate < today;
        if (isExhausted || isExpired) {
            let reason = [];
            if (isExhausted) reason.push(`remaining balance is ₹${remainingBalance} (exhausted)`);
            if (isExpired)   reason.push(`package expired on ${pData.expiryDate}`);
            alert(`⚠️ Package Exhausted/Expired: ${reason.join(" and ")}.`);
        }

        // (b) Financial summary — totalAmount + renamed remainingBalance caption + (c) discount %
        if (financialEl) {
            const detailsEl = document.getElementById("utilize-pack-financial-details");
            if (detailsEl) {
                const unpaidClass = unpaidBalance > 0 ? "text-danger" : "text-success";
                const discBadge = discountPct > 0
                    ? `<span class="badge bg-success ms-1">${discountPct.toFixed(1)}% discount</span>`
                    : `<span class="badge bg-secondary ms-1">No discount</span>`;
                detailsEl.innerHTML = `
                    <div class="row g-2">
                        <div class="col-6"><span class="text-muted">Total Services Amount (₹):</span> <strong>${totalAmount !== null ? "₹" + totalAmount.toLocaleString("en-IN") : "N/A"}</strong></div>
                        <div class="col-6"><span class="text-muted">Selling Price (₹):</span> <strong>${soldPrice !== null ? "₹" + soldPrice.toLocaleString("en-IN") : "N/A"} ${discBadge}</strong></div>
                        <div class="col-6"><span class="text-muted">Amount Received Before This Visit (₹):</span> <strong>₹${amtReceived.toLocaleString("en-IN")}</strong></div>
                        <div class="col-6"><span class="text-muted">Unpaid Balance Before This Visit (₹):</span> <strong class="${unpaidClass}">₹${unpaidBalance.toLocaleString("en-IN")}</strong></div>
                        <div class="col-12"><span class="text-muted">Services of Amount yet to be availed (₹):</span> <strong class="text-primary">₹${remainingBalance.toLocaleString("en-IN")}</strong></div>
                    </div>`;
            }
            financialEl.style.display = "block";
        }

        // (c) Show/hide addl-amt field based on unpaid balance
        const addlAmtWrapper = document.getElementById("utilize-addl-amt-wrapper");
        if (addlAmtWrapper) addlAmtWrapper.style.display = unpaidBalance > 0 ? "" : "none";

        updateUtilizeNewUnpaidDisplay();

        const isType3 = pData.packType === "Type3";

        // Join: build serviceCode -> serviceName lookup from services collection,
        // matching ownerUserNo (same scope as subServices queries below)
        const srvNameMap = new Map();
        const srvForNameSnap = await getDocs(query(collection(db, "services"), where("ownerUserNo", "==", activeSessionUser.ownerUserNo)));
        srvForNameSnap.forEach(d => {
            const s = d.data();
            srvNameMap.set(s.serviceCode, s.serviceName);
        });

        if (isType3) {
            // (a) Type3: fetch ALL subservices for this owner, exclude those in subServicesArray
            const excludedCodes = new Set(pData.subServicesArray || []);
            const allSsQ = query(collection(db, "subServices"),
                where("ownerUserNo", "==", activeSessionUser.ownerUserNo),
                where("active", "==", true));
            const allSsSnap = await getDocs(allSsQ);
            let anyRendered = false;
            allSsSnap.forEach(doc => {
                const ss = doc.data();
                if (excludedCodes.has(ss.subServiceCode)) return; // skip excluded
                const origRate = Number(ss.rate);
                const parentServiceName = srvNameMap.get(ss.serviceCode) || "";
                const displayName = parentServiceName ? `${ss.subServiceName} (${parentServiceName})` : ss.subServiceName;
                // (b) Type3: only original price, green bold, no strikethrough, data-rate = origRate
                container.innerHTML += `
                    <div class="form-check">
                        <input class="form-check-input chk-utilize-subservice" type="checkbox" value="${ss.subServiceCode}" data-rate="${origRate}" id="chk-ut-${ss.subServiceCode}">
                        <label class="form-check-label small" for="chk-ut-${ss.subServiceCode}">
                            ${displayName} — <span class="text-success fw-bold">₹${origRate.toLocaleString("en-IN")}</span>
                        </label>
                    </div>`;
                anyRendered = true;
            });
            if (!anyRendered) {
                container.innerHTML = `<span class="text-muted small">All service items are available for this package.</span>`;
            }
        } else {
            // Type1 / Type2: original behaviour — show only items in subServicesArray
            if (!pData.subServicesArray || pData.subServicesArray.length === 0) {
                container.innerHTML = `<span class="text-muted small">This package tier allows choice across all salon items without any explicit service restrictions rules.</span>`;
                container.querySelectorAll(".chk-utilize-subservice").forEach(chk => _attachStaffDropdownHandler(chk));
                if (totalEl) totalEl.style.display = "block";
                return;
            }

            // (c) Helper: round discounted price — nearest 10 if < 1000, nearest 100 otherwise
            const applyDiscount = (rate) => {
                const discounted = rate * (1 - discountPct / 100);
                if (discounted < 1000) return Math.round(discounted / 10) * 10;
                return Math.round(discounted / 100) * 100;
            };

            for (const code of pData.subServicesArray) {
                const ssQ = query(collection(db, "subServices"), where("ownerUserNo", "==", activeSessionUser.ownerUserNo), where("subServiceCode", "==", code));
                const ssSnap = await getDocs(ssQ);
                if (!ssSnap.empty) {
                    const ss = ssSnap.docs[0].data();
                    const origRate       = Number(ss.rate);
                    const discountedRate = applyDiscount(origRate);
                    const parentServiceName = srvNameMap.get(ss.serviceCode) || "";
                    const displayName = parentServiceName ? `${ss.subServiceName} (${parentServiceName})` : ss.subServiceName;
                    const priceLabel = discountPct > 0
                        ? `<span class="text-decoration-line-through text-muted me-1">₹${origRate.toLocaleString("en-IN")}</span><span class="text-success fw-bold">₹${discountedRate.toLocaleString("en-IN")}</span>`
                        : `<span class="fw-bold">₹${origRate.toLocaleString("en-IN")}</span>`;
                    container.innerHTML += `
                        <div class="form-check">
                            <input class="form-check-input chk-utilize-subservice" type="checkbox" value="${ss.subServiceCode}" data-rate="${discountedRate}" id="chk-ut-${ss.subServiceCode}">
                            <label class="form-check-label small" for="chk-ut-${ss.subServiceCode}">
                                ${displayName} — ${priceLabel}
                            </label>
                        </div>`;
                }
            }
        }

        container.querySelectorAll(".chk-utilize-subservice").forEach(chk => {
            _attachStaffDropdownHandler(chk);
        });
        if (totalEl) totalEl.style.display = "block";

        // Load visit history for this package + customer
        await renderVisitHistory(allotId, customerNo);

    } catch (err) { await handleTelemetryAlert("Dynamic Subservice Checker Interface", err); }
}

async function renderVisitHistory(allotId, customerNo) {
    const panel  = document.getElementById("utilize-visit-history");
    const tbody  = document.getElementById("tbl-utilize-visit-history");
    if (!panel || !tbody) return;

    panel.style.display = "none";
    tbody.innerHTML = "";
    if (!allotId || !customerNo) return;

    try {
        const logsQ = query(collection(db, "serviceUtilizationLogs"),
            where("ownerUserNo", "==", activeSessionUser.ownerUserNo),
            where("allotId",     "==", allotId),
            where("customerNo",  "==", customerNo));
        const logsSnap = await getDocs(logsQ);
        if (logsSnap.empty) return;

        // Collect all unique subServiceCodes across all logs for a single batch name lookup
        const allCodes = new Set();
        logsSnap.forEach(d => (d.data().itemsRendered || []).forEach(c => allCodes.add(c)));

        // Fetch subservice names in parallel
        const nameMap = {};
        await Promise.all([...allCodes].map(async code => {
            const q = query(collection(db, "subServices"),
                where("ownerUserNo", "==", activeSessionUser.ownerUserNo),
                where("subServiceCode", "==", code));
            const snap = await getDocs(q);
            nameMap[code] = snap.empty ? code : snap.docs[0].data().subServiceName;
        }));

        // Sort logs by visitDate descending
        const logs = logsSnap.docs.map(d => d.data()).sort((a, b) => b.visitDate.localeCompare(a.visitDate));

        logs.forEach(log => {
            const serviceNames = (log.itemsRendered || []).map(c => nameMap[c] || c).join(", ") || "—";
            const totalAmt     = Number(log.calculatedValueCost || 0).toLocaleString("en-IN");
            const amtReceived  = Number(log.addlAmtReceived     || 0).toLocaleString("en-IN");
            const tr = document.createElement("tr");
            tr.innerHTML = `
                <td class="text-nowrap">${log.visitDate || "—"}</td>
                <td>${serviceNames}</td>
                <td class="text-end">₹${totalAmt}</td>
                <td class="text-end">₹${amtReceived}</td>`;
            tbody.appendChild(tr);
        });

        panel.style.display = "block";
    } catch (err) { console.error("Visit history load error:", err); }
}

function updateUtilizeNewUnpaidDisplay() {
    const addlAmtEl = document.getElementById("utilize-addl-amt-received");
    const newUnpaidEl = document.getElementById("utilize-new-unpaid-display");
    if (!newUnpaidEl) return;
    const addl = parseFloat(addlAmtEl ? addlAmtEl.value : "") || 0;
    const newUnpaid = utilizePrevUnpaidBalance - addl;
    if (utilizePrevUnpaidBalance === 0 && addl === 0) {
        newUnpaidEl.textContent = "";
        return;
    }
    if (newUnpaid > 0) {
        newUnpaidEl.textContent = `₹${newUnpaid.toLocaleString("en-IN")} still unpaid`;
        newUnpaidEl.className = "fw-bold small text-nowrap text-danger";
    } else if (newUnpaid < 0) {
        newUnpaidEl.textContent = `₹${Math.abs(newUnpaid).toLocaleString("en-IN")} overpaid`;
        newUnpaidEl.className = "fw-bold small text-nowrap text-warning";
    } else {
        newUnpaidEl.textContent = "Fully paid ✓";
        newUnpaidEl.className = "fw-bold small text-nowrap text-success";
    }
}

function updateUtilizeServicesTotal() {
    const totalEl = document.getElementById("utilize-services-total");
    if (!totalEl) return;
    const checked = document.querySelectorAll(".chk-utilize-subservice:checked");
    if (checked.length === 0) {
        totalEl.textContent = "Selected services total: ₹0";
        return;
    }
    let total = 0;
    checked.forEach(chk => { total += Number(chk.getAttribute("data-rate")) || 0; });
    totalEl.textContent = `Selected services total: ₹${total.toLocaleString("en-IN")} (${checked.length} item${checked.length === 1 ? "" : "s"})`;
}

// =========================================================================
// Old Visit Modification Helpers
// =========================================================================

function resetOldVisitUI() {
    _oldVisitLogDocRef    = null;
    _oldVisitPrevCalcCost = 0;
    _oldVisitPrevAddlAmt  = 0;

    const wrapper = document.getElementById("utilize-old-visit-wrapper");
    if (wrapper) wrapper.style.display = "none";

    const dateSelect = document.getElementById("utilize-old-visit-date-select");
    if (dateSelect) { dateSelect.innerHTML = `<option value="">-- Select a Previous Visit Date --</option>`; }

    // Show Save, hide Delete
    const saveBtn = document.getElementById("btn-utilize-submit");
    const delBtn  = document.getElementById("btn-utilize-delete");
    if (saveBtn) saveBtn.classList.remove("d-none");
    if (delBtn)  delBtn.classList.add("d-none");

    // Re-enable all form fields
    ["utilize-visit-date","utilize-addl-amt-received"].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.removeAttribute("readonly");
    });

    // Clear checkboxes
    document.querySelectorAll(".chk-utilize-subservice").forEach(cb => {
        cb.disabled = false;
        cb.checked  = false;
    });
}

async function populateOldVisitDates() {
    const custNo  = document.getElementById("utilize-customer-select").value;
    const allotId = document.getElementById("utilize-pack-select").value;
    const wrapper = document.getElementById("utilize-old-visit-wrapper");
    const dateSelect = document.getElementById("utilize-old-visit-date-select");

    if (!custNo || !allotId || !activeSessionUser) {
        alert("Please select a Customer and a Package first before choosing Old Visit.");
        document.getElementById("utilize-visit-new").checked = true;
        return;
    }

    if (wrapper) wrapper.style.display = "block";

    const ownerNo = activeSessionUser.role === "OWNER"
        ? activeSessionUser.userNo : activeSessionUser.ownerUserNo;

    try {
        const logsQ = query(collection(db, "serviceUtilizationLogs"),
            where("ownerUserNo", "==", ownerNo),
            where("allotId",     "==", allotId),
            where("customerNo",  "==", custNo));
        const logsSnap = await getDocs(logsQ);

        dateSelect.innerHTML = `<option value="">-- Select a Previous Visit Date --</option>`;
        const logs = [];
        logsSnap.forEach(d => logs.push({ id: d.id, ref: d.ref, ...d.data() }));
        logs.sort((a, b) => (b.visitDate || "").localeCompare(a.visitDate || ""));

        if (logs.length === 0) {
            dateSelect.innerHTML = `<option value="">No previous visits found</option>`;
            return;
        }
        logs.forEach(log => {
            const opt = document.createElement("option");
            opt.value = log.id;
            opt.textContent = `${log.visitDate} — ${(log.itemsRendered || []).length} service(s), Addl Amt: ₹${log.addlAmtReceived || 0}`;
            opt.dataset.logData = JSON.stringify(log);
            dateSelect.appendChild(opt);
        });
    } catch(err) { await handleTelemetryAlert("Old Visit Date Population", err); }
}

async function prefillOldVisitData() {
    const dateSelect = document.getElementById("utilize-old-visit-date-select");
    const selectedOpt = dateSelect.options[dateSelect.selectedIndex];
    if (!selectedOpt || !selectedOpt.dataset.logData) return;

    let log;
    try { log = JSON.parse(selectedOpt.dataset.logData); }
    catch { return; }

    _oldVisitLogDocRef    = log.ref || null;
    _oldVisitPrevCalcCost = Number(log.calculatedValueCost || 0);
    _oldVisitPrevAddlAmt  = Number(log.addlAmtReceived     || 0);

    // Pre-fill visit date
    const visitDateEl = document.getElementById("utilize-visit-date");
    if (visitDateEl) visitDateEl.value = log.visitDate || "";

    // Pre-fill addlAmtReceived — only populate if non-zero [point f]
    const addlEl = document.getElementById("utilize-addl-amt-received");
    if (addlEl) {
        const addlVal = Number(log.addlAmtReceived || 0);
        addlEl.value = addlVal !== 0 ? addlVal : "";
    }

    // Pre-check services from itemsRendered and restore staff dropdowns
    const prevItems    = log.itemsRendered    || [];
    const prevProviders = log.serviceProviders || []; // array of {userNo, role}
    document.querySelectorAll(".chk-utilize-subservice").forEach(cb => {
        cb.checked = prevItems.includes(cb.value);
        if (cb.checked) {
            const wrapper = cb.closest(".form-check");
            if (wrapper && !wrapper.querySelector(".staff-provider-select")) {
                wrapper.insertAdjacentHTML("beforeend", _buildStaffDropdownHtml(cb.value));
            }
            // Restore previous provider selection
            const idx = prevItems.indexOf(cb.value);
            const provider = idx >= 0 ? prevProviders[idx] : null;
            if (provider) {
                const sel = wrapper?.querySelector(".staff-provider-select");
                if (sel) sel.value = provider.userNo || "";
            }
        }
    });

    // Show Delete button alongside Save
    const delBtn = document.getElementById("btn-utilize-delete");
    if (delBtn) delBtn.classList.remove("d-none");
}

async function deleteOldVisitRecord() {
    if (!_oldVisitLogDocRef) return alert("Please select a previous visit date first.");

    if (!confirm("⚠️ Delete this visit record? The package balance will be restored. This cannot be undone.")) return;

    try {
        const custNo  = document.getElementById("utilize-customer-select").value;
        const allotId = document.getElementById("utilize-pack-select").value;

        // Get the log data to reverse
        const logSnap = await getDoc(_oldVisitLogDocRef);
        if (!logSnap.exists()) return alert("Error: Visit record not found.");
        const logData = logSnap.data();

        // Restore balance in customerServicePacks
        const packQ = query(collection(db, "customerServicePacks"),
            where("ownerUserNo", "==", activeSessionUser.ownerUserNo),
            where("allotId",     "==", allotId));
        const packSnap = await getDocs(packQ);
        if (packSnap.empty) return alert("Error: Package record not found.");

        const packRef  = packSnap.docs[0].ref;
        const pData    = packSnap.docs[0].data();

        const restoredBalance = Number(pData.remainingBalance) +
            (pData.packType === "Type1"
                ? Number(logData.unitsSubtracted || 0)
                : Number(logData.calculatedValueCost || 0));

        const restoredUnpaid = Math.max(0,
            Number(pData.unpaidBalance || 0) - Number(logData.addlAmtReceived || 0));

        await updateDoc(packRef, {
            remainingBalance: restoredBalance,
            unpaidBalance:    restoredUnpaid,
            lastVisitDate:    null   // will be recalculated on next visit
        });

        // Delete the log document
        await deleteDoc(_oldVisitLogDocRef);

        // Recalculate lastVisitDate from remaining logs
        const remainingLogsQ = query(collection(db, "serviceUtilizationLogs"),
            where("ownerUserNo", "==", activeSessionUser.ownerUserNo),
            where("allotId",     "==", allotId));
        const remainingLogsSnap = await getDocs(remainingLogsQ);
        let newLastVisitDate = null;
        remainingLogsSnap.forEach(d => {
            const vd = d.data().visitDate || null;
            if (vd && (!newLastVisitDate || vd > newLastVisitDate)) newLastVisitDate = vd;
        });
        await updateDoc(packRef, { lastVisitDate: newLastVisitDate });

        alert("✅ Visit record deleted and package balance restored.");
        resetOldVisitUI();
        document.getElementById("utilize-visit-new").checked = true;
        await renderVisitHistory(allotId, custNo);

    } catch(err) { await handleTelemetryAlert("Old Visit Delete", err); }
}

// Collect service providers in same order as itemsRendered
function _collectServiceProviders(checkedInputs) {
    const providers = [];
    checkedInputs.forEach(input => {
        const wrapper = input.closest(".form-check");
        const sel = wrapper?.querySelector(".staff-provider-select");
        if (sel && sel.value) {
            const selOpt = sel.options[sel.selectedIndex];
            providers.push({
                userNo: sel.value,
                role: selOpt?.dataset?.role || ""
            });
        } else {
            providers.push({ userNo: "", role: "" });
        }
    });
    return providers;
}

async function processVisitDeductionFormSubmission(e) {
    e.preventDefault();

    const isOldVisit = document.getElementById("utilize-visit-old")?.checked;

    // === OLD VISIT: update existing log ===
    if (isOldVisit) {
        if (!_oldVisitLogDocRef) return alert("Please select a previous visit date to modify.");

        const custNo  = document.getElementById("utilize-customer-select").value;
        const allotId = document.getElementById("utilize-pack-select").value;
        const visitDate = document.getElementById("utilize-visit-date").value;
        const newAddlAmt = parseFloat(document.getElementById("utilize-addl-amt-received")?.value) || 0;

        const checkedInputs = document.querySelectorAll(".chk-utilize-subservice:checked");
        let newCalcCost = 0;
        const newItemCodes = [];
        checkedInputs.forEach(input => {
            newCalcCost += Number(input.getAttribute("data-rate"));
            newItemCodes.push(input.value);
        });

        if (checkedInputs.length === 0 && newAddlAmt === 0)
            return alert("Validation: Please select at least one service or enter an additional amount.");

        try {
            // Get pack for packType
            const packQ = query(collection(db, "customerServicePacks"),
                where("ownerUserNo", "==", activeSessionUser.ownerUserNo),
                where("allotId",     "==", allotId));
            const packSnap = await getDocs(packQ);
            if (packSnap.empty) return alert("Error: Package record not found.");
            const packRef = packSnap.docs[0].ref;
            const pData   = packSnap.docs[0].data();

            // Reverse old deduction, apply new deduction
            const oldDeduction = pData.packType === "Type1"
                ? Number(document.getElementById("utilize-old-visit-date-select")
                    .options[document.getElementById("utilize-old-visit-date-select").selectedIndex]
                    .dataset.logData ? JSON.parse(document.getElementById("utilize-old-visit-date-select")
                    .options[document.getElementById("utilize-old-visit-date-select").selectedIndex]
                    .dataset.logData).unitsSubtracted || 0 : 0)
                : _oldVisitPrevCalcCost;
            const newDeduction = pData.packType === "Type1" ? checkedInputs.length : newCalcCost;

            const balanceDiff  = oldDeduction - newDeduction; // positive = balance restored
            const addlAmtDiff  = newAddlAmt - _oldVisitPrevAddlAmt;
            const newBalance   = Number(pData.remainingBalance) + balanceDiff;
            const newUnpaid    = Math.max(0, Number(pData.unpaidBalance || 0) - addlAmtDiff);

            await updateDoc(packRef, { remainingBalance: newBalance, unpaidBalance: newUnpaid, lastVisitDate: visitDate });

            // Update the log document — replace all modifiable fields
            await updateDoc(_oldVisitLogDocRef, {
                itemsRendered:       newItemCodes,
                serviceProviders:    _collectServiceProviders(checkedInputs),
                visitDate:           visitDate,
                calculatedValueCost: newCalcCost,
                addlAmtReceived:     newAddlAmt,
            });

            alert(`✅ Visit record updated. New Package Balance: ${newBalance}`);
            resetOldVisitUI();
            document.getElementById("utilize-visit-new").checked = true;
            await renderVisitHistory(allotId, custNo);
            document.getElementById("frm-utilize-service-visit").reset();
            const _uSrch = document.getElementById("utilize-customer-search");
            if (_uSrch) { _uSrch.value = ""; _uSrch.dispatchEvent(new Event("input")); }
            document.getElementById("container-utilize-subservices").innerHTML = "";

        } catch(err) { await handleTelemetryAlert("Old Visit Modification", err); }
        return;
    }

    // === NEW VISIT (original logic below, unchanged) ===
    const custNo = document.getElementById("utilize-customer-select").value;
    const allotId = document.getElementById("utilize-pack-select").value;
    const visitDate = document.getElementById("utilize-visit-date").value;
    const addlAmtReceived = parseFloat(document.getElementById("utilize-addl-amt-received") ? document.getElementById("utilize-addl-amt-received").value : "") || 0;

    const checkedInputs = document.querySelectorAll(".chk-utilize-subservice:checked");
    // (d) Either addl amount received > 0 OR at least one service selected (or both)
    const addlPositive = addlAmtReceived > 0;
    const anyChecked   = checkedInputs.length > 0;
    if (!addlPositive && !anyChecked)
        return alert("Validation: Please either enter an additional amount received, or select at least one service item availed during this visit (or both).");

    try {
        const q = query(collection(db, "customerServicePacks"), where("ownerUserNo", "==", activeSessionUser.ownerUserNo), where("allotId", "==", allotId)); 
        const res = await getDocs(q);
        if (res.empty) return alert("Error: The chosen package file references could not be verified.");
        
        const docRef = res.docs[0].ref;
        const pData = res.docs[0].data();

        // Rule Validation: Date Conflict checking framework rules
        if (pData.startDate && visitDate < pData.startDate) {
            return alert("Date Violation: Today's visit date occurs before the package package was actually activated.");
        }
        if (pData.expiryDate && visitDate > pData.expiryDate) {
            return alert("Date Violation: Today's visit occurs after this customer contract balance has officially expired.");
        }

        let totalSubServicesValueCost = 0;
        let renderedItemCodeTrackers = [];

        checkedInputs.forEach(input => {
            totalSubServicesValueCost += Number(input.getAttribute("data-rate"));
            renderedItemCodeTrackers.push(input.value);
        });

        let updatedBalance = Number(pData.remainingBalance);
        if (pData.packType === "Type1") {
            updatedBalance = updatedBalance - checkedInputs.length;
        } else {
            updatedBalance = updatedBalance - totalSubServicesValueCost;
        }

        if (updatedBalance < 0) {
            // Show red alert and prompt user to confirm override save
            const overrideMsg =
                `⛔ Transaction Declined: This package balance card does not have enough remaining capacity.\n` +
                `Balance Available: ${pData.remainingBalance}\n` +
                `Balance After This Visit: ${updatedBalance}\n\n` +
                `Do you still want to save this visit record (override)?`;
            const confirmed = window.confirm(overrideMsg);
            if (!confirmed) return;

            // User confirmed override — proceed to save, then email owner
            const ownerEmail = activeSessionUser.email || "bawa.codes@gmail.com";

            // Save the record first (fall through to rest of function),
            // flag for post-save owner email
            _utilizeOverrideConfirmed = true;
            _utilizeOverrideMeta = {
                ownerEmail,
                custNo,
                allotId,
                packName: pData.packName,
                balanceBefore: pData.remainingBalance,
                balanceAfter: updatedBalance
            };
        } else {
            _utilizeOverrideConfirmed = false;
            _utilizeOverrideMeta = null;
        }

        // Query all prior logs for this allotId+customerNo to get true cumulative payments
        const priorLogsQ = query(collection(db, "serviceUtilizationLogs"),
            where("ownerUserNo", "==", activeSessionUser.ownerUserNo),
            where("allotId",     "==", allotId),
            where("customerNo",  "==", custNo));
        const priorLogsSnap = await getDocs(priorLogsQ);
        let sumPriorAddlPaid = 0;
        priorLogsSnap.forEach(d => { sumPriorAddlPaid += Number(d.data().addlAmtReceived || 0); });

        // b: amtReceived = pData.amountReceived + sum of all prior addlAmtReceived in logs
        const initialAmtReceived = Number(pData.amountReceived !== undefined ? pData.amountReceived : 0);
        const trueAmtReceived    = initialAmtReceived + sumPriorAddlPaid + addlAmtReceived;

        // c: unpaidBalance = soldPrice - trueAmtReceived
        const packSoldPrice    = Number(pData.soldPrice !== undefined ? pData.soldPrice : 0);
        const newUnpaidBalance = Math.max(0, packSoldPrice - trueAmtReceived);

        const nowExhausted = updatedBalance <= 0;
        // a: Do NOT update amountReceived in customerServicePacks — it stays as initially recorded
        const exhaustionUpdate = { remainingBalance: updatedBalance, unpaidBalance: newUnpaidBalance, lastVisitDate: visitDate };
        if (nowExhausted) exhaustionUpdate.expiryDate = visitDate;
        await updateDoc(docRef, exhaustionUpdate);
        if (nowExhausted)
            alert(`⚠️ Package Fully Exhausted: "${pData.packName}" consumed. Expiry set to ${visitDate}.`);

        // Issue 1: sequential log ID — max existing serial for this owner + 1
        const allLogsQ = query(collection(db, "serviceUtilizationLogs"),
            where("ownerUserNo", "==", activeSessionUser.ownerUserNo));
        const allLogsSnap = await getDocs(allLogsQ);
        let maxLogSerial = 0;
        const logDocPattern = new RegExp(`^${activeSessionUser.ownerUserNo}_LOG_(\\d+)$`);
        allLogsSnap.forEach(d => {
            const m = d.id.match(logDocPattern);
            if (m) { const n = parseInt(m[1], 10); if (!isNaN(n) && n > maxLogSerial) maxLogSerial = n; }
        });
        const logSerial = maxLogSerial + 1;
        const logDocId  = `${activeSessionUser.ownerUserNo}_LOG_${logSerial}`;

        await setDoc(doc(db, "serviceUtilizationLogs", logDocId), {
            ownerUserNo: activeSessionUser.ownerUserNo, logId: logDocId,
            customerNo: custNo, allotId: allotId,
            packName: pData.packName, visitDate: visitDate,
            itemsRendered: renderedItemCodeTrackers,
            serviceProviders: _collectServiceProviders(checkedInputs),
            unitsSubtracted: checkedInputs.length, calculatedValueCost: totalSubServicesValueCost,
            addlAmtReceived: addlAmtReceived, loggedAt: new Date().toISOString()
        });

        // Override-save: notify owner by email if user confirmed negative-balance save
        if (_utilizeOverrideConfirmed && _utilizeOverrideMeta) {
            const m = _utilizeOverrideMeta;
            try {
                await emailjs.send('service_050166', 'template_050166', {
                    to_email: m.ownerEmail,
                    subject: "⛔ OVERRIDE ALERT — Visit Saved with Negative Package Balance",
                    body: `Override Save Notification:\n\nA visit record has been saved despite insufficient package balance.\n\nCustomer ID: ${m.custNo}\nAllotment ID: ${m.allotId}\nPackage Name: ${m.packName}\nBalance Before Visit: ${m.balanceBefore}\nBalance After Visit: ${m.balanceAfter}\n\nPlease review this account at the earliest.`
                });
            } catch (_emailErr) { /* silent — do not block UI if email fails */ }
            _utilizeOverrideConfirmed = false;
            _utilizeOverrideMeta = null;
        }

        // Rule Validation: 20% Low-Balance Warning alerts dispatch pipeline via EmailJS 
        const warningThreshold = Number(pData.totalAmount) * 0.20;
        if (updatedBalance < warningThreshold) {
            alert("Low Balance Warning: This client's package balance has fallen below 20%. The salon owner has been notified via email reminder rules.");
            await emailjs.send('service_050166', 'template_050166', {
                to_email: 'bawa.codes@gmail.com',
                subject: "FOLLOWUP REMINDER ALERT - Low Capacity Package Detected",
                body: `Low Balance Notice:\nCustomer ID Reference: ${custNo}\nAllotment Account: ${allotId}\nRemaining Balance Capacity: ${updatedBalance}`
            });
        } else {
            alert(`Visit logged successfully. Remaining Account Balance: ${updatedBalance}`);
        }

        // Refresh visit history in place (before resetting the form)
        await renderVisitHistory(allotId, custNo);

        document.getElementById("frm-utilize-service-visit").reset();
        const _uSrch = document.getElementById("utilize-customer-search");
        if (_uSrch) { _uSrch.value = ""; _uSrch.dispatchEvent(new Event("input")); }
        document.getElementById("container-utilize-subservices").innerHTML = "";
        utilizePrevUnpaidBalance = 0;
        const financialEl = document.getElementById("utilize-pack-financial");
        if (financialEl) financialEl.style.display = "none";
        const totalEl = document.getElementById("utilize-services-total");
        if (totalEl) { totalEl.style.display = "none"; totalEl.textContent = ""; }
        const newUnpaidEl = document.getElementById("utilize-new-unpaid-display");
        if (newUnpaidEl) newUnpaidEl.textContent = "";
        const addlEl = document.getElementById("utilize-addl-amt-received");
        if (addlEl) addlEl.value = "0";
    } catch (err) { await handleTelemetryAlert("Service Visit Transaction Node", err); }
}

// =========================================================================
// Real-Time UI Presenter Tables
// =========================================================================
async function refreshAllAdministrativeTables() {
    if(!activeSessionUser) return;
    const ownerId = activeSessionUser.ownerUserNo;

    const renderTable = async (colName, elementId, rowBuilder) => {
        const q = query(collection(db, colName), where("ownerUserNo", "==", ownerId)); 
        const snap = await getDocs(q);
        const tbody = document.getElementById(elementId);
        if(tbody) {
            tbody.innerHTML = "";
            snap.forEach(d => tbody.appendChild(rowBuilder(d.data(), d.id)));
        }
    };

    {
        const catQ = query(collection(db, "serviceCategories"),
            where("ownerUserNo", "==", ownerId),
            where("active", "==", true));
        const catSnap = await getDocs(catQ);
        const catTbody = document.getElementById("tbl-adm-categories");
        if (catTbody) {
            catTbody.innerHTML = "";
            catSnap.forEach(d => {
                const data = d.data();
                const tr = document.createElement("tr");
                tr.innerHTML = `<td><strong>[${data.catCode}]</strong></td><td>${data.catName}</td>`;
                catTbody.appendChild(tr);
            });
        }
    }

    {
        const srvQ = query(collection(db, "services"),
            where("ownerUserNo", "==", ownerId),
            where("active", "==", true));
        const srvSnap = await getDocs(srvQ);
        const srvTbody = document.getElementById("tbl-adm-services");
        if (srvTbody) {
            srvTbody.innerHTML = "";
            srvSnap.forEach(d => {
                const data = d.data();
                const tr = document.createElement("tr");
                tr.innerHTML = `<td><strong>[${data.serviceCode}]</strong></td><td>${data.serviceName}</td>`;
                srvTbody.appendChild(tr);
            });
        }
    }

    {
        // Fetch subServices grouped by serviceCode, show serviceName from services as heading
        const effectiveOwnerId = _ownerFilter();
        let ssSnap = await getDocs(query(collection(db, "subServices"),
            where("ownerUserNo", "==", effectiveOwnerId),
            where("active", "==", true)));
        if (ssSnap.empty) {
            ssSnap = await getDocs(query(collection(db, "subServices"),
                where("ownerUserNo", "==", "000"),
                where("active", "==", true)));
        }

        // Also fetch services for serviceCode→serviceName lookup, using the same
        // effective ownerUserNo comparison as the sub-parent-srv dropdown: first try
        // services where ownerUserNo matches the effective owner, and only if no such
        // record exists, fall back to services where ownerUserNo === "000".
        const srvNameMap = new Map();
        let srvForNameSnap = await getDocs(query(collection(db, "services"), where("ownerUserNo", "==", effectiveOwnerId)));
        if (srvForNameSnap.empty) {
            srvForNameSnap = await getDocs(query(collection(db, "services"), where("ownerUserNo", "==", "000")));
        }
        srvForNameSnap.forEach(d => { const s = d.data(); srvNameMap.set(s.serviceCode, s.serviceName); });

        // Group subServices by serviceCode
        const grouped = new Map();
        ssSnap.forEach(d => {
            const data = d.data();
            if (!grouped.has(data.serviceCode)) grouped.set(data.serviceCode, []);
            grouped.get(data.serviceCode).push(data);
        });

        const ssTbody = document.getElementById("tbl-adm-subservices");
        if (ssTbody) {
            ssTbody.innerHTML = "";
            grouped.forEach((items, serviceCode) => {
                const srvName = srvNameMap.get(serviceCode) || serviceCode;
                // Group heading row spanning 4 cols (2 cols × 2 sub-cols each)
                const headTr = document.createElement("tr");
                headTr.innerHTML = `<td colspan="4" class="fw-bold text-uppercase bg-light small py-1 px-2">${srvName}</td>`;
                ssTbody.appendChild(headTr);

                // Render items in pairs (2 per row)
                items.sort((a, b) => (a.subServiceName || "").localeCompare(b.subServiceName || ""));
                for (let i = 0; i < items.length; i += 2) {
                    const tr = document.createElement("tr");
                    const left  = items[i];
                    const right = items[i + 1];
                    const leftCell  = `<td class="ps-3 small">${left.subServiceName}</td><td class="text-end small pe-3"><strong>₹${left.rate}</strong></td>`;
                    const rightCell = right
                        ? `<td class="ps-3 small">${right.subServiceName}</td><td class="text-end small pe-3"><strong>₹${right.rate}</strong></td>`
                        : `<td></td><td></td>`;
                    tr.innerHTML = leftCell + rightCell;
                    ssTbody.appendChild(tr);
                }
            });
        }
    }

    // (c) tbl-adm-commonpacks: show Type3 packages only
    {
        const packType3Q = query(collection(db, "commonServicePacks"),
            where("ownerUserNo", "==", ownerId),
            where("packType", "==", "Type3"));
        const packType3Snap = await getDocs(packType3Q);
        const packTbody = document.getElementById("tbl-adm-commonpacks");
        if (packTbody) {
            packTbody.innerHTML = "";
            packType3Snap.forEach(d => {
                const data = d.data();
                const tr = document.createElement("tr");
                const serviceCount = data.subServicesArray ? data.subServicesArray.length : 0;
                const discount = (data.totalAmount > 0 && data.offerPrice >= 0)
                    ? ((data.totalAmount - data.offerPrice) / data.totalAmount * 100)
                    : null;
                const discountBadge = (discount !== null && discount > 0)
                    ? ` <span class="badge bg-success ms-1">${discount.toFixed(1)}% off</span>`
                    : "No Discount";

                const linkedWord = (data.packType === "Type3") ? "excluded" : "included";
                tr.innerHTML = `
                    <td>${data.packName}</td>
                    <td hidden><span class="badge bg-dark">${data.packType === "Type1" ? "Item Counts" : "Cash Value Balance"}</span></td>
                    <td>₹${data.offerPrice}${discountBadge}</td>
                    <td>₹${data.totalAmount}</td>
                    <td>${serviceCount} item${serviceCount === 1 ? "" : "s"} ${linkedWord}</td>
                    <td><span class="badge ${data.active ? 'bg-success' : 'bg-secondary'}">${data.active ? 'Active' : 'Hidden'}</span></td>
                    <td><button class="btn btn-outline-secondary btn-sm py-0 px-2 copy-pack-btn" title="Copy package summary to clipboard">📋 Copy</button></td>`;

                tr.querySelector(".copy-pack-btn").addEventListener("click", () => {
                    const discountLine = (discount !== null && discount > 0)
                        ? `\nDiscount: ${discount.toFixed(1)}% off list price`
                        : "";
                    const summary = [
                        `📦 ${data.packName}`,
                        `Offered Price: ₹${data.offerPrice}${discountLine}`,
                        `Total Services Value: ₹${data.totalAmount}`,
                        `Includes: ${serviceCount} service item${serviceCount === 1 ? "" : "s"}`,
                        `Status: ${data.active ? "Available for subscription" : "Currently unavailable"}`
                    ].join("\n");

                    navigator.clipboard.writeText(summary).then(() => {
                        const btn = tr.querySelector(".copy-pack-btn");
                        btn.textContent = "✅ Copied!";
                        btn.classList.replace("btn-outline-secondary", "btn-success");
                        setTimeout(() => {
                            btn.textContent = "📋 Copy";
                            btn.classList.replace("btn-success", "btn-outline-secondary");
                        }, 2000);
                    }).catch(() => {
                        alert("Clipboard access was blocked. Please copy manually.");
                    });
                });

                packTbody.appendChild(tr);
            });
        }
    }

    // tbl-adm-users: apply role filter matching the current active form mode
    {
        const currentMode = document.getElementById("sec-adm-users")?.dataset?.userMode;
        if (currentMode) {
            // Mode is set — delegate entirely to _refreshUserTableForMode for correct role filter
            await _refreshUserTableForMode(currentMode);
        } else {
            // No mode set — fallback: show all users (should not happen in normal flow)
            const usrQ = query(collection(db, "users"),
                where("ownerUserNo", "==", ownerId));
            const usrSnap = await getDocs(usrQ);
            const usrTbody = document.getElementById("tbl-adm-users");
            if (usrTbody) {
                usrTbody.innerHTML = "";
                usrSnap.forEach(d => {
                    const data = d.data();
                    const tr = document.createElement("tr");
                    tr.innerHTML = `<td>#${data.userNo}</td><td><span class="badge bg-secondary text-uppercase">${data.role}</span></td><td><strong>${data.name}</strong></td><td>${data.phone || "—"}</td><td>${data.email || "—"}</td><td><span class="badge ${data.active?'bg-success':'bg-secondary'}">${data.active?'Active Card':'Archived'}</span></td><td>-</td>`;
                    usrTbody.appendChild(tr);
                });
            }
        }
    }
}

async function loadWorkspaceDropdownMappings() {
    if (!activeSessionUser) return;
    const ownerId = activeSessionUser.ownerUserNo;

    const populateSelect = async (colName, elementId, valKey, txtKey, customFilterRole) => {
        let q = query(collection(db, colName), where("ownerUserNo", "==", ownerId)); 
        if (customFilterRole) {
            q = query(collection(db, colName), where("ownerUserNo", "==", ownerId), where("role", "==", customFilterRole)); 
        }
        const snap = await getDocs(q);
        const el = document.getElementById(elementId);
        if(el) {
            el.innerHTML = `<option value="">-- Choose from Available List --</option>`;
            snap.forEach(d => {
                const data = d.data();
                el.innerHTML += `<option value="${data[valKey]}">${data[txtKey]} (ID: ${data[valKey]})</option>`;
            });
        }
    };

    await populateSelect("serviceCategories", "srv-parent-cat", "catCode", "catName");
    await populateSelect("serviceCategories", "cat-select-existing", "catCode", "catName");
    await populateSelect("services", "srv-select-existing", "serviceCode", "serviceName");
    {
        const effectiveOwnerId = _ownerFilter();
        let srvSnap = await getDocs(query(collection(db, "services"), where("ownerUserNo", "==", effectiveOwnerId)));
        if (srvSnap.empty) {
            srvSnap = await getDocs(query(collection(db, "services"), where("ownerUserNo", "==", "000")));
        }
        const subParentEl = document.getElementById("sub-parent-srv");
        if (subParentEl) {
            subParentEl.innerHTML = `<option value="">-- Choose from Available List --</option>`;
            srvSnap.forEach(d => {
                const data = d.data();
                subParentEl.innerHTML += `<option value="${data.serviceCode}">${data.serviceName} (ID: ${data.serviceCode})</option>`;
            });
            subParentEl._allOptions = Array.from(subParentEl.options);
        }
    }
    {
        const packQ = query(collection(db, "commonServicePacks"),
            where("ownerUserNo", "==", ownerId),
            where("packType", "==", "Type3"));
        const packSnap = await getDocs(packQ);
        allotPacksCache.clear();
        const allotSelectEl = document.getElementById("allot-pack-select");
        if (allotSelectEl) {
            allotSelectEl.innerHTML = `<option value="">-- Choose from Available List --</option>`;
            packSnap.forEach(d => {
                const data = d.data();
                allotPacksCache.set(data.packName, data);
                const packId = data.id || d.id;
                allotSelectEl.innerHTML += `<option value="${data.packName}">${data.packName} (Pack ID: ${packId})</option>`;
            });
            allotSelectEl._allOptions = Array.from(allotSelectEl.options);
        }
    }
    // (b) pack-select-existing: show Type3 packages only
    {
        const pseQ = query(collection(db, "commonServicePacks"),
            where("ownerUserNo", "==", ownerId),
            where("packType", "==", "Type3"));
        const pseSnap = await getDocs(pseQ);
        const pse = document.getElementById("pack-select-existing");
        if (pse) {
            pse.innerHTML = `<option value="">-- Choose from Available List --</option>`;
            pseSnap.forEach(d => {
                const data = d.data();
                pse.innerHTML += `<option value="${data.packName}">${data.packName} (ID: ${data.packName})</option>`;
            });
            pse._allOptions = Array.from(pse.options);
        }
    }
    await populateSelect("users", "allot-customer-select", "userNo", "name", "CUSTOMER");
    {
        const _acEl = document.getElementById("allot-customer-select");
        if (_acEl) _acEl._allOptions = Array.from(_acEl.options);
    }
    // utilize-customer-select: value=userNo, display=name + phone (not userNo)
    {
        const custQ = query(collection(db, "users"),
            where("ownerUserNo", "==", ownerId),
            where("role", "==", "CUSTOMER"));
        const custSnap = await getDocs(custQ);
        const ucEl = document.getElementById("utilize-customer-select");
        if (ucEl) {
            ucEl.innerHTML = `<option value="">-- Choose from Available List --</option>`;
            custSnap.forEach(d => {
                const data = d.data();
                ucEl.innerHTML += `<option value="${data.userNo}">${data.name} (Ph: ${data.phone || "—"})</option>`;
            });
            ucEl._allOptions = Array.from(ucEl.options);
        }
    }

    const userProfileSelect = document.getElementById("usr-select-existing");
    if (userProfileSelect) {
        // Respect active user form mode: Customer Registration → CUSTOMER only;
        // Staff Registration → MANAGER/STAFF only; no mode set → all users
        const activeMode = document.getElementById("sec-adm-users")?.dataset?.userMode;
        let usersQuery;
        if (activeMode === "CUSTOMER") {
            usersQuery = query(collection(db, "users"),
                where("ownerUserNo", "==", ownerId),
                where("role", "==", "CUSTOMER"));
        } else if (activeMode === "MANAGER") {
            usersQuery = query(collection(db, "users"),
                where("ownerUserNo", "==", ownerId),
                where("role", "in", ["MANAGER", "STAFF"]));
        } else {
            usersQuery = query(collection(db, "users"),
                where("ownerUserNo", "==", ownerId));
        }
        const usersSnap = await getDocs(usersQuery);
        userProfileSelect.innerHTML = `<option value="">-- Choose from Available List --</option>`;
        usersSnap.forEach(d => {
            const data = d.data();
            userProfileSelect.innerHTML += `<option value="${data.userNo}">${data.name} — ${data.role} (ID: ${data.userNo})</option>`;
        });
        userProfileSelect._allOptions = Array.from(userProfileSelect.options);
    }

    await populateSelect("subServices", "sub-select-existing", "subServiceCode", "subServiceName");
    { const _s = document.getElementById("sub-select-existing"); if (_s) _s._allOptions = Array.from(_s.options); }
}

function setupMediaPreviewListener(inputId, imgId) {
    const fileEl = document.getElementById(inputId);
    const imgEl = document.getElementById(imgId);
    if (!fileEl || !imgEl) return;

    fileEl.addEventListener("change", function() {
        const assetFile = this.files[0];
        if (assetFile) {
            const reader = new FileReader();
            reader.onload = (e) => {
                imgEl.src = e.target.result;
                imgEl.style.display = "block"; 
            };
            reader.readAsDataURL(assetFile);
        } else {
            imgEl.src = "";
            imgEl.style.display = "none"; // Rule check: Suppress layout placeholders when asset is empty
        }
    });
}
