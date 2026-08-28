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

const WEB = /\b(\w*cari\w*|search\w*|berita|news|temukan|find|google|duckduckgo|wikipedia|bing|yahoo)\b/i;
const APP = /\b(buka|launch|jalankan|run|bukakan|tutup|close|focus|fokus|kunjungi)\b/i;
const COMPUTER = /\b(ketik|ketikkan|type|klik|click|scroll|tekan|press|drag|tahan|hold|arahkan|move|geser)\b/i;
const FILE = /\b(file|cari file|buka file|dokumen|folder|direktori)\b/i;
const SCREEN = /\b(layar|screen|screenshot|tangkapan|capture|tampilan)\b/i;
const MATH = /[\d]+\s*[\+\-\*\/\%\^]\s*[\d]/;

function createQuestionRouter(opts) {
    opts = opts || {};
    const detectUrl = typeof opts.detectUrl === 'function' ? opts.detectUrl : (() => null);
    const appProvider = opts.appProvider || null;
    const computerControl = opts.computerControl || null;
    const hasScreen = typeof opts.hasScreen === 'function' ? opts.hasScreen : (() => false);

    return function needsAgent(question) {
        const q = String(question == null ? '' : question);

        // URL present -> open_url tool
        if (detectUrl(q)) return true;
        // arithmetic -> keep the calculator tool working
        if (MATH.test(q)) return true;
        // explicit web / file / screen intents
        if (WEB.test(q)) return true;
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

module.exports = { createQuestionRouter, WEB, APP, COMPUTER, FILE, SCREEN, MATH };
