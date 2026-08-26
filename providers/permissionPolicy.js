// PermissionPolicy (Phase 12): the SINGLE decision entry point for tool use.
// Pure CJS module. Policy is metadata-only — it never executes anything and
// knows nothing about tool implementations or AI plumbing.
//
// Matrix (defaults): LOW -> allow, MEDIUM -> allow, HIGH -> confirm,
// unknown/missing risk -> deny (fail-closed).
//
// Additional gates, all funneled through decide():
//   - agent disabled            -> deny everything (defense in depth)
//   - computer-control tool + "allow computer control" off -> deny
//
// No shell, no execution, no side effects. Ever.

const DEFAULT_MATRIX = { LOW: 'allow', MEDIUM: 'allow', HIGH: 'confirm' };

// pointer/keyboard/window tools gated by the explicit computer-control
// setting. launch_app/open_file stay general MEDIUM tools.
const COMPUTER_TOOLS = ['click', 'type_text', 'press_key', 'scroll', 'focus_app'];

function createPermissionPolicy(opts) {
    opts = opts || {};
    const matrix = opts.matrix || DEFAULT_MATRIX;
    const computerTools = opts.computerTools || COMPUTER_TOOLS;
    const isAgentEnabled = opts.isAgentEnabled || (() => true);
    const isComputerControlAllowed = opts.isComputerControlAllowed || (() => true);

    // decide(toolId, riskLevel) -> 'allow' | 'confirm' | 'deny'
    function decide(id, riskLevel) {
        if (!isAgentEnabled()) return 'deny';
        const risk = String(riskLevel || '');
        if (!Object.prototype.hasOwnProperty.call(matrix, risk)) return 'deny';
        if (computerTools.indexOf(String(id)) !== -1 && !isComputerControlAllowed()) {
            return 'deny';
        }
        return matrix[risk];
    }

    return { decide: decide };
}

module.exports = { createPermissionPolicy, COMPUTER_TOOLS, DEFAULT_MATRIX };
