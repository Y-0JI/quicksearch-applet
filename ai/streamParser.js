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
        }
    }

    function _handleEventBlock(block) {
        if (!block || !block.trim()) return; // empty keepalive

        const lines = block.split('\n');
        let dataLines = [];

        for (const line of lines) {
            // SSE format: "field: value" or "field" (no colon = no value)
            // Only "data:" lines carry OpenAI payload
            if (line.indexOf('data:') === 0) {
                const value = line.slice(5); // after "data:"
                dataLines.push(value);
            }
            // Ignore event:, id:, retry:, comments (:), and unknown fields
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
            // JSON parse failure — emit error but don't crash
            // Could be incomplete JSON across reads; accumulate instead
            // Put the event back for later processing
            buffer = 'data: ' + dataStr + '\n\n' + buffer;
            // Check if this looks like an incomplete JSON (no closing brace/bracket)
            if (_isIncompleteJson(dataStr)) {
                // Don't emit error yet — this chunk may complete with next feed
                return;
            }
            // Invalid but complete JSON — skip this event
            return;
        }

        // Emit start event on first data
        if (!started) {
            started = true;
            _emit({ type: 'start' });
        }

        // Extract delta content from OpenAI-compatible format
        // { choices: [{ delta: { content: "text" } }] }
        if (payload && typeof payload === 'object') {
            // Check for error in payload
            if (payload.error) {
                _emitError(
                    payload.error.code || 'provider_error',
                    payload.error.message || 'Provider error'
                );
                return;
            }

            // Extract content from choices[0].delta.content
            const text = _extractDeltaText(payload);
            if (text !== null) {
                accumulatedText += text;
                _emit({ type: 'delta', text: text });
                return;
            }

            // Also handle choices[0].message.content (non-streaming format occasionally seen)
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
            return choice.delta.content;
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
        // Simple heuristic: count unmatched braces/brackets
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
        // Flush any remaining buffer as a final event
        if (done) return;
        if (buffer.trim()) {
            // Process whatever is left
            _processBuffer();
        }
        // Only emit complete if stream was started (at least one event received)
        if (!done && started) {
            _emitComplete();
        }
    }

    function isDone() { return done; }
    function getAccumulatedText() { return accumulatedText; }

    return { feed, flush, isDone, getAccumulatedText };
}

module.exports = { createStreamParser };
