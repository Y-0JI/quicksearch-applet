// Question router (Phase 13 latency fix): decides whether a user question
// needs the tool-enabled agent loop or can take the Fast Path (a single
// model call with NO tool definitions).
//
// Pure CJS, loader-safe: NO project-relative requires. All detectors arrive
// via injection so it runs under node --test AND Cinnamon GJS. The applet wires
// the real detectors; tests inject fakes.
//
// Returns a function (question) -> boolean:
//   true  => needs the agent loop (a tool is likely required)
//   false => Fast Path (general knowledge / explanation; no tools)

const WEB = /\b(\w*cari\w*|search\w*|berita|news|temukan|find|google|duckduckgo|wikipedia|bing|yahoo|harga|kurs|price|saham|ihsg|idx|emas|perak|bitcoin|usd|dollar|rupiah|antam)\b/i;
const TEMPORAL = /\b(hari\s*ini|terbaru|terkini|saat\s*ini|sekarang|update|hariini)\b/i;
const APP = /\b(buka|launch|jalankan|run|bukakan|tutup|close|focus|fokus|kunjungi)\b/i;
const COMPUTER = /\b(ketik|ketikkan|type|klik|click|scroll|tekan|press|drag|tahan|hold|arahkan|move|geser)\b/i;
const FILE = /\b(file|cari file|buka file|dokumen|folder|direktori)\b/i;
const SCREEN = /\b(layar|screen|screenshot|tangkapan|capture|tampilan)\b/i;
const MATH = /[\d]+\s*[\+\-\*\/\%\^]\s*[\d]/;
// Explicit "open/visit/launch" intent (loader-safe duplicate of
// agentManager.OPEN_URL_INTENT). A question with this should use the agent
// loop so open_url is available. Duplicated to avoid a relative require.
const OPEN_URL = /\b((?:buka|bukakan|kunjungi|visit|launch|open)\s+(?:artikel|link|url|website|web|halaman|laman|situs|berita|page|article|browser|sumber)|(?:buka|kunjungi|launch|open)\s+di\s+browser|tampilkan\s+di\s+browser)\b/i;

function createQuestionRouter(opts) {
    opts = opts || {};
    const detectUrl = typeof opts.detectUrl === 'function' ? opts.detectUrl : (() => null);
    const appProvider = opts.appProvider || null;
    const computerControl = opts.computerControl || null;
    const hasScreen = typeof opts.hasScreen === 'function' ? opts.hasScreen : (() => false);

    return function needsAgent(question) {
        const q = String(question == null ? '' : question);

        // Explicit open/visit/launch request -> agent loop (open_url available)
        if (OPEN_URL.test(q)) return true;
        // URL present -> open_url tool
        if (detectUrl(q)) return true;
        // arithmetic -> keep the calculator tool working
        if (MATH.test(q)) return true;
        // explicit web / file / screen intents
        if (WEB.test(q)) return true;
        if (TEMPORAL.test(q)) return true;
        if (FILE.test(q)) return true;
        if (hasScreen() && SCREEN.test(q)) return true;
        // computer control verbs only matter when control is enabled
        if (computerControl && COMPUTER.test(q)) return true;
        // app launch intent: require a matching app so "buka pintu" stays Fast Path
        if (APP.test(q)) {
            if (!appProvider || typeof appProvider.searchApps !== 'function') return true;
            const apps = appProvider.searchApps(q);
            if (apps && apps.length) return true;
            return false; // "buka" with no known app -> don't force a loop
        }
        // general knowledge / explanation -> Fast Path
        return false;
    };
}

module.exports = { createQuestionRouter, WEB, TEMPORAL, APP, COMPUTER, FILE, SCREEN, MATH, OPEN_URL };
