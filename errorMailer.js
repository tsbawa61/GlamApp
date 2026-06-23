/**
 * GlamTrack Telemetry & Diagnostic System Engine
 * Intercepts runtime exception crashes and routes them via EmailJS 
 * to the Super User while generating explicit structured logs.
 */

// Explicit system connection coordinates (From Item 23 of your specifications)
const EMAILJS_SERVICE  = 'service_050166';
const EMAILJS_TEMPLATE = 'template_050166';
const EMAILJS_KEY      = 'hWr0F4DVvhcHN3D5v';

if (typeof emailjs !== 'undefined') {
    emailjs.init(EMAILJS_KEY);
}

/**
 * Captures, processes, and packages operating crashes to send to bawa.codes@gmail.com.
 */
export async function reportRuntimeCrash(ownerName, activeSessionContext, errorObject) {
    console.error("GlamTrack Core caught an operational execution breakdown:", errorObject);

    // Assembles standardized database log structures (From Item 22 of your specifications)
    const errorLog = {
        errorId: "ERR_" + Math.floor(100000 + Math.random() * 900000),
        ownerUserNo: activeSessionContext ? activeSessionContext.ownerUserNo : "000",
        userInLogin: activeSessionContext ? activeSessionContext.name : "Anonymous/Guest",
        salonOwnerName: ownerName || "Unassigned Salon Context",
        errorMessage: errorObject.message || String(errorObject),
        errorStack: errorObject.stack || "No line trace generated.",
        timestamp: new Date().toISOString(), // Current date, non-editable
        notifiedSuperUser: false
    };

    try {
        if (typeof emailjs === 'undefined') {
            console.warn("Telemetry distribution engine unavailable: EmailJS script dependency missing.");
            return errorLog;
        }

        // --- THE UPDATED CHANGE: FORCED RECIPIENT HOOK ---
        await emailjs.send(EMAILJS_SERVICE, EMAILJS_TEMPLATE, {
            to_email: 'bawa.codes@gmail.com', // Explicitly locks the target destination
            subject: `CRITICAL ALERT: System Error generated in ${errorLog.salonOwnerName}'s workspace`,
            body: `
                GlamTrack Error Log Event Report:
                ------------------------------------------------------------
                Log Reference ID   : ${errorLog.errorId}
                Salon Name Hook    : ${errorLog.salonOwnerName}
                Scope Owner ID     : ${errorLog.ownerUserNo}
                Active Login User  : ${errorLog.userInLogin}
                Incident Timestamp : ${errorLog.timestamp}

                Error Summary Description:
                ------------------------------------------------------------
                ${errorLog.errorMessage}

                Detailed Call Stack Frame Trace:
                ------------------------------------------------------------
                ${errorLog.errorStack}
            `
        });

        errorLog.notifiedSuperUser = true; // Flips state flag matching specification rules
        console.log("Telemetry exception payload successfully dispatched to Super User.");
    } catch (emailjsNetworkBreak) {
        console.error("Failed to route diagnostic data over network telemetry lines:", emailjsNetworkBreak);
    }

    return errorLog;
}