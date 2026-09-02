// ai/streamParser.js — SSE stream parser for OpenAI-compatible streaming responses.
// Pure, no I/O, no Cinnamon deps. Feeds raw text chunks, emits normalized events.
//
// SSE format (conceptual):
//   data: {"choices":[{"delta":{"content":"Hello"}}]}\n
//   \n
//   data: {"choices":[{"delta":{"content":" world"}}]}\n
//   \n
//   data: [DONE]\n
//
// Contract §6 (AI-6 spec):
//   { type: 'start' }
//   { type: 'delta', text: 'partial text' }
//   { type: 'tool_call', tool: 'web_search', arguments: { query: '...' } }
//   { type: 'complete', result: { text, sources, grounded } }
//   { type: 'error', error: { code, message } }
//
// Key requirements:
//   - one network read can contain multiple events
//   - one event can span multiple reads
//   - JSON can span reads
//   - empty keepalive events ignored
//   - [DONE] handled once
//   - unknown metadata safely ignored

const DONE_MARKER = '[DONE]';

function createStreamParser(opts) {
    opts = opts || {};
    const onEvent = typeof opts.onEvent === 'function' ? opts.onEvent : null;
    const onError = typeof opts.onError === 'function' ? opts.onError : null;

    let buffer = '';
    let done = false;
    let started = false;

    // Accumulated text from delta events
    let accumulatedText = '';

    // Accumulated tool_call arguments (OpenAI streams tool_calls incrementally)
    let pendingToolCall = null;
    let toolCallId = null;
    let toolCallEmitted = false;

    function feed(rawChunk) {
        if (done) return;
        if (typeof rawChunk !== 'string') return;
        buffer += rawChunk;
        _processBuffer();
    }

    function _processBuffer() {
        // SSE events are separated by \n\n (blank line).
        // Process all complete events in the buffer.
        while (true) {
            const boundary = buffer.indexOf('\n\n');
            if (boundary === -1) break;

            const eventBlock = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + 2);

            _handleEventBlock(eventBlock);
            if (done) break;
        }
    }

    function _handleEventBlock(block) {
        if (!block || !block.trim()) return; // empty keepalive

        const lines = block.split('\n');
        let dataLines = [];

        for (const line of lines) {
            if (line.indexOf('data:') === 0) {
                const value = line.slice(5); // after "data:"
                dataLines.push(value);
            }
        }

        if (dataLines.length === 0) return; // no data lines, skip

        const dataStr = dataLines.join('\n');

        // Check for [DONE] marker
        if (dataStr.trim() === DONE_MARKER) {
            _emitComplete();
            return;
        }

        // Try to parse JSON payload
        let payload;
        try {
            payload = JSON.parse(dataStr);
        } catch (e) {
            // Distinguish incomplete transport data vs complete malformed event.
            // Incomplete JSON (brackets unclosed) stays in buffer for next feed.
            // Complete malformed JSON (valid SSE boundary but invalid JSON) is skipped.
            if (_isIncompleteJson(dataStr)) {
                // Incomplete — put back and wait for next chunk
                buffer = 'data: ' + dataStr + '\n\n' + buffer;
                return;
            }
            // Complete malformed event — skip safely, do not reinsert
            return;
        }

        // Emit start event on first data
        if (!started) {
            started = true;
            _emit({ type: 'start' });
        }

        // Check for error in payload
        if (payload && typeof payload === 'object' && payload.error) {
            _emitError(
                payload.error.code || 'provider_error',
                payload.error.message || 'Provider error'
            );
            return;
        }

        if (payload && typeof payload === 'object') {
            // Try tool_calls first (streaming tool_call path)
            const tc = _extractToolCallDelta(payload);
            if (tc !== null) {
                if (toolCallEmitted) return;
                // Accumulate incremental tool_call arguments
                if (!pendingToolCall) {
                    pendingToolCall = { tool: tc.name || 'web_search', argumentsStr: '' };
                    if (tc.id) toolCallId = tc.id;
                }
                if (typeof tc.argumentsFragment === 'string') {
                    pendingToolCall.argumentsStr += tc.argumentsFragment;
                }
                if (tc.name && pendingToolCall) {
                    pendingToolCall.tool = tc.name;
                }
                // If arguments look complete (valid JSON with query), emit tool_call now
                // But wait for at least some accumulation; also handle finish on DONE
                // For incremental streaming, emit once we have a parseable complete arguments
                const query = _tryExtractQuery(pendingToolCall.argumentsStr);
                if (query !== null) {
                    if (toolCallEmitted) return;
                    toolCallEmitted = true;
                    // Emit tool_call event; engine will handle grounding
                    _emit({ type: 'tool_call', tool: pendingToolCall.tool, arguments: { query: query } });
                    // Don't duplicate emit on DONE; pending handled
                }
                return;
            }

            // Also check non-streaming tool_calls format (message.tool_calls)
            const tcMsg = _extractToolCallMessage(payload);
            if (tcMsg !== null) {
                if (toolCallEmitted) return;
                if (!started) { started = true; _emit({ type: 'start' }); }
                toolCallEmitted = true;
                _emit({ type: 'tool_call', tool: tcMsg.tool, arguments: tcMsg.arguments });
                return;
            }

            // Extract delta content from OpenAI-compatible format
            const text = _extractDeltaText(payload);
            if (text !== null) {
                accumulatedText += text;
                _emit({ type: 'delta', text: text });
                return;
            }

            const msgText = _extractMessageText(payload);
            if (msgText !== null) {
                accumulatedText += msgText;
                _emit({ type: 'delta', text: msgText });
                return;
            }
        }
        // Unknown payload shape — safely ignored per spec
    }

    function _extractDeltaText(payload) {
        try {
            if (!Array.isArray(payload.choices) || payload.choices.length === 0) return null;
            const choice = payload.choices[0];
            if (!choice || typeof choice !== 'object') return null;
            if (!choice.delta || typeof choice.delta !== 'object') return null;
            if (typeof choice.delta.content !== 'string') return null;
            // If delta also contains tool_calls without content, it's tool_call not text
            return choice.delta.content;
        } catch (e) {
            return null;
        }
    }

    function _extractToolCallDelta(payload) {
        try {
            if (!Array.isArray(payload.choices) || payload.choices.length === 0) return null;
            const choice = payload.choices[0];
            if (!choice || typeof choice !== 'object') return null;
            const delta = choice.delta;
            if (!delta || typeof delta !== 'object') return null;
            if (!Array.isArray(delta.tool_calls) || delta.tool_calls.length === 0) return null;
            const tc = delta.tool_calls[0];
            if (!tc || typeof tc !== 'object') return null;
            let name = null;
            let argsFrag = null;
            let id = tc.id || null;
            if (tc.function && typeof tc.function === 'object') {
                if (typeof tc.function.name === 'string') name = tc.function.name;
                if (typeof tc.function.arguments === 'string') argsFrag = tc.function.arguments;
            }
            // Some providers use 'function' at top level
            if (name === null && typeof tc.name === 'string') name = tc.name;
            if (argsFrag === null && typeof tc.arguments === 'string') argsFrag = tc.arguments;
            // If both null but tc exists, treat as signal fragment
            if (name === null && argsFrag === null) return null;
            return { name: name, argumentsFragment: argsFrag || '', id: id };
        } catch (e) {
            return null;
        }
    }

    function _extractToolCallMessage(payload) {
        try {
            if (!Array.isArray(payload.choices) || payload.choices.length === 0) return null;
            const choice = payload.choices[0];
            if (!choice || typeof choice !== 'object') return null;
            const msg = choice.message;
            if (!msg || typeof msg !== 'object') return null;
            if (!Array.isArray(msg.tool_calls) || msg.tool_calls.length === 0) return null;
            const tc = msg.tool_calls[0];
            if (!tc || typeof tc !== 'object') return null;
            let tool = 'web_search';
            let args = {};
            if (tc.function && typeof tc.function === 'object') {
                if (typeof tc.function.name === 'string') tool = tc.function.name;
                if (typeof tc.function.arguments === 'string') {
                    try { args = JSON.parse(tc.function.arguments); } catch (e) { args = {}; }
                } else if (typeof tc.function.arguments === 'object') {
                    args = tc.function.arguments;
                }
            }
            return { tool: tool, arguments: args };
        } catch (e) {
            return null;
        }
    }

    function _tryExtractQuery(argsStr) {
        if (!argsStr || typeof argsStr !== 'string') return null;
        const s = argsStr.trim();
        if (!s) return null;
        // Only emit if it looks like complete JSON object
        if (s[0] !== '{' || s[s.length - 1] !== '}') return null;
        try {
            const obj = JSON.parse(s);
            if (obj && typeof obj.query === 'string' && obj.query.trim()) return obj.query.trim();
            return null;
        } catch (e) {
            return null;
        }
    }

    function _extractMessageText(payload) {
        try {
            if (!Array.isArray(payload.choices) || payload.choices.length === 0) return null;
            const choice = payload.choices[0];
            if (!choice || typeof choice !== 'object') return null;
            if (!choice.message || typeof choice.message !== 'object') return null;
            if (typeof choice.message.content !== 'string') return null;
            return choice.message.content;
        } catch (e) {
            return null;
        }
    }

    function _isIncompleteJson(str) {
        const trimmed = str.trim();
        if (!trimmed) return false;
        let braces = 0, brackets = 0, inString = false, escape = false;
        for (let i = 0; i < trimmed.length; i++) {
            const ch = trimmed[i];
            if (escape) { escape = false; continue; }
            if (ch === '\\') { escape = true; continue; }
            if (ch === '"') { inString = !inString; continue; }
            if (inString) continue;
            if (ch === '{') braces++;
            else if (ch === '}') braces--;
            else if (ch === '[') brackets++;
            else if (ch === ']') brackets--;
        }
        return braces > 0 || brackets > 0;
    }

    function _emitComplete() {
        if (done) return;
        done = true;
        if (!started) {
            started = true;
            _emit({ type: 'start' });
        }
        // If pending tool_call was accumulated but never emitted (e.g., arguments completed exactly at DONE),
        // emit it now if valid, instead of empty complete — but at most once per stream
        if (!toolCallEmitted && pendingToolCall && pendingToolCall.argumentsStr) {
            const q = _tryExtractQuery(pendingToolCall.argumentsStr);
            if (q !== null) {
                toolCallEmitted = true;
                _emit({ type: 'tool_call', tool: pendingToolCall.tool, arguments: { query: q } });
                // Still emit complete with empty text for streaming harness to settle
                // The engine will handle tool_call prior to complete
            }
        }
        _emit({
            type: 'complete',
            result: {
                text: accumulatedText,
                sources: [],
                grounded: false
            }
        });
    }

    function _emitError(code, message) {
        if (done) return;
        done = true;
        _emit({
            type: 'error',
            error: { code: code || 'provider_error', message: message || 'Provider error' }
        });
    }

    function _emit(evt) {
        if (onEvent) {
            try { onEvent(evt); } catch (e) {
                if (onError) try { onError(e); } catch (_) {}
            }
        }
    }

    function flush() {
        if (done) return;
        if (buffer.trim()) {
            _processBuffer();
        }
        if (!done && started) {
            _emitComplete();
        }
    }

    function isDone() { return done; }
    function getAccumulatedText() { return accumulatedText; }

    return { feed, flush, isDone, getAccumulatedText };
}

module.exports = { createStreamParser };
