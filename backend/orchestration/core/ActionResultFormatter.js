// ActionResultFormatter.js
/**
 * ActionResultFormatter (Production-ready)
 *
 * Goal:
 * - Deterministically format tool execution results (Composio + other wrappers) into human-friendly summaries.
 * - Provide consistent outputs across Jira, Google Calendar, Gmail, Slack, Axonaut, GitHub.
 * - Optional LLM enhancement layer (polish only, no hallucinations) with strict JSON output + fallback.
 *
 * Usage:
 *   const { ActionResultFormatter } = require("./ActionResultFormatter");
 *   const formatter = new ActionResultFormatter({ callLLM: callGeminiLikeFn, defaultTimezone: "America/New_York" });
 *   const out = await formatter.format("JIRA_SEARCH_FOR_ISSUES_USING_JQL_GET", { success:true, data:{...} }, { params:{...} }, { useLLM:true });
 *   // out => { success, summary, details, objectId, links, service, action, structured, data }
 */

"use strict";

// -----------------------------
// Small utilities
// -----------------------------
function safeString(v, fallback = "") {
    if (v === null || v === undefined) return fallback;
    try {
        return String(v);
    } catch (_) {
        return fallback;
    }
}

function truncate(text, max = 240) {
    const s = safeString(text, "");
    if (!s) return "";
    if (s.length <= max) return s;
    return s.slice(0, Math.max(0, max - 1)) + "…";
}

function clamp(n, min, max) {
    const x = Number(n);
    if (!Number.isFinite(x)) return min;
    return Math.min(max, Math.max(min, x));
}

function get(obj, path, fallback = undefined) {
    if (!obj || typeof obj !== "object") return fallback;
    const parts = Array.isArray(path) ? path : safeString(path).split(".");
    let cur = obj;
    for (const p of parts) {
        if (!cur || typeof cur !== "object") return fallback;
        cur = cur[p];
    }
    return cur === undefined ? fallback : cur;
}

function firstNonEmpty(...vals) {
    for (const v of vals) {
        if (v === null || v === undefined) continue;
        if (typeof v === "string" && v.trim() === "") continue;
        if (Array.isArray(v) && v.length === 0) continue;
        return v;
    }
    return null;
}

function pickFirstArray(payload, paths = []) {
    for (const p of paths) {
        const arr = get(payload, p);
        if (Array.isArray(arr) && arr.length) return arr;
    }
    return [];
}

function dedupeStrings(arr) {
    if (!Array.isArray(arr)) return [];
    const seen = new Set();
    const out = [];
    for (const v of arr) {
        const s = safeString(v, "").trim();
        if (!s) continue;
        const key = s.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(s);
    }
    return out;
}

function looksLikeUrl(s) {
    const x = safeString(s, "").trim();
    return /^https?:\/\/\S+/i.test(x);
}

function formatDateTime(dateLike, timezone = "America/New_York", opts = {}) {
    if (!dateLike) return "";
    try {
        const d = new Date(dateLike);
        if (Number.isNaN(d.getTime())) return safeString(dateLike, "");
        return d.toLocaleString("en-US", {
            timeZone: timezone,
            weekday: "short",
            month: "short",
            day: "numeric",
            hour: "numeric",
            minute: "2-digit",
            ...opts,
        });
    } catch (_) {
        return safeString(dateLike, "");
    }
}

function humanCount(n, singular, plural = null) {
    const x = Number(n);
    if (!Number.isFinite(x)) return `0 ${plural || singular + "s"}`;
    if (x === 1) return `1 ${singular}`;
    return `${x} ${plural || singular + "s"}`;
}

function normalizeEmailDisplay(from) {
    const s = safeString(from, "").trim();
    if (!s) return "Unknown";
    // "Name <email@x.com>" -> "Name"
    const m = s.match(/^([^<]+)<[^>]+>$/);
    if (m && m[1]) return m[1].trim();
    return s;
}

// -----------------------------
// Composio/Wrapper normalization
// -----------------------------
function normalizeToolResult(rawResult) {
    // Accepts shapes like:
    // - { success:true, data:{...} }
    // - { data:{ success:true, data:{...}} }
    // - { successfulExecutions:[{data:{...}}], failedExecutions:[...]}
    // - plain payload objects
    const result = rawResult && typeof rawResult === "object" ? rawResult : { data: rawResult };
    const success =
        result.success === false
            ? false
            : result.success === true
                ? true
                : result.error
                    ? false
                    : true;

    const error =
        firstNonEmpty(
            result.error,
            result.message && success === false ? result.message : null,
            get(result, "data.error"),
            get(result, "data.message") && get(result, "data.success") === false ? get(result, "data.message") : null
        ) || null;

    // Step 1: unwrap result.data
    let payload = result.data !== undefined ? result.data : result;

    // Step 2: composio often wraps as { success:true, data:{...} }
    if (payload && typeof payload === "object" && payload.success === true && payload.data && typeof payload.data === "object") {
        payload = payload.data;
    }

    // Step 3: some wrappers nest under response/response_data
    payload = firstNonEmpty(
        get(payload, "response.data"),
        get(payload, "response_data"),
        get(payload, "data") && typeof get(payload, "data") === "object" ? get(payload, "data") : null,
        payload
    );

    // Step 4: support "successfulExecutions"
    const successfulExecutions = get(result, "successfulExecutions") || get(payload, "successfulExecutions");
    if (Array.isArray(successfulExecutions) && successfulExecutions.length) {
        const first = successfulExecutions.find((x) => x && (x.data || x.response || x.output)) || successfulExecutions[0];
        payload = firstNonEmpty(first?.data, first?.response?.data, first?.output, payload);
    }

    // Step 5: failures list (for partial success)
    const failedExecutions = get(result, "failedExecutions") || get(payload, "failedExecutions");

    return {
        success: !!success && !error,
        error,
        payload,
        raw: rawResult,
        meta: {
            successfulExecutions: Array.isArray(successfulExecutions) ? successfulExecutions : null,
            failedExecutions: Array.isArray(failedExecutions) ? failedExecutions : null,
        },
    };
}

function extractLinks(payload) {
    if (!payload || typeof payload !== "object") return [];
    const candidates = [
        payload.htmlLink,
        payload.browser_url,
        payload.webUrl,
        payload.url,
        payload.self,
        get(payload, "data.htmlLink"),
        get(payload, "event_data.htmlLink"),
        get(payload, "issue.url"),
        get(payload, "repository.html_url"),
        get(payload, "pull_request.html_url"),
        get(payload, "html_url"),
    ].filter(Boolean);

    return dedupeStrings(candidates.filter(looksLikeUrl));
}

function actionToService(actionUpper) {
    if (actionUpper.includes("JIRA")) return "jira";
    if (actionUpper.includes("GOOGLECALENDAR") || actionUpper.includes("CALENDAR")) return "calendar";
    if (actionUpper.includes("GMAIL")) return "gmail";
    if (actionUpper.includes("SLACK")) return "slack";
    if (actionUpper.includes("AXONAUT")) return "axonaut";
    if (actionUpper.includes("GITHUB")) return "github";
    if (actionUpper.startsWith("SYSTEM_")) return "system";
    return "unknown";
}

function classifyVerb(actionUpper) {
    // Very light verb classification: used for fallback behavior.
    if (/(CREATE|ADD|POST|SEND|OPEN|START)/.test(actionUpper)) return "create";
    if (/(UPDATE|EDIT|PATCH|MODIFY|SET)/.test(actionUpper)) return "update";
    if (/(DELETE|REMOVE|ARCHIVE)/.test(actionUpper)) return "delete";
    if (/(GET|FETCH|READ|RETRIEVE)/.test(actionUpper)) return "get";
    if (/(LIST|SEARCH|FIND|QUERY)/.test(actionUpper)) return "list";
    return "other";
}

// -----------------------------
// LLM helper (polish layer)
// -----------------------------
function safeJsonParse(maybeJsonText) {
    const s = safeString(maybeJsonText, "");
    if (!s) return null;
    // Attempt to extract first JSON object
    const m = s.match(/\{[\s\S]*\}/);
    if (!m) return null;
    try {
        return JSON.parse(m[0]);
    } catch (_) {
        return null;
    }
}

function buildLLMPolishPrompt({ action, service, deterministic, structured, timezone }) {
    // IMPORTANT: instruct model to only rephrase; do not invent facts.
    const facts = {
        action,
        service,
        timezone,
        deterministic: {
            summary: deterministic.summary,
            details: deterministic.details,
            objectId: deterministic.objectId || null,
            links: deterministic.links || [],
            success: deterministic.success,
        },
        structured: structured || {},
    };

    return `
You are a formatting assistant for a production tool-orchestrator.
You MUST NOT invent any facts. Only use facts explicitly present in "facts".
If something is missing/unknown, do NOT guess; keep it generic.

Task:
- Produce a concise, user-friendly "summary" and optional "details" string.
- Keep content faithful to facts. Preserve IDs/keys/times/links exactly.
- If success=false, explain the failure clearly using the provided error text only.

Output STRICT JSON only:
{"summary":"...","details":"..."}.

facts:
${JSON.stringify(facts, null, 2)}
`.trim();
}

// -----------------------------
// Main class
// -----------------------------
class ActionResultFormatter {
    /**
     * @param {Object} opts
     * @param {Function|null} opts.callLLM - async (prompt, system, temperature) => string (Gemini/OpenAI wrapper)
     * @param {string} opts.defaultTimezone
     * @param {number} opts.maxItems - max list items to render in details
     * @param {number} opts.maxDetailsChars - hard cap to prevent giant messages
     * @param {number} opts.llmTemperature
     * @param {boolean} opts.enableLLMByDefault
     */
    constructor(opts = {}) {
        this.callLLM = typeof opts.callLLM === "function" ? opts.callLLM : null;

        this.defaultTimezone = opts.defaultTimezone || "America/New_York";
        this.maxItems = clamp(opts.maxItems ?? 10, 3, 25);
        this.maxDetailsChars = clamp(opts.maxDetailsChars ?? 1800, 500, 6000);

        this.llmTemperature = typeof opts.llmTemperature === "number" ? opts.llmTemperature : 0.2;
        this.enableLLMByDefault = opts.enableLLMByDefault === true;

        // Exact action formatters (best reliability)
        this.registry = {
            // Gmail - include all aliases for robustness
            GMAIL_LIST_EMAILS: this._fmtGmailList.bind(this),
            GMAIL_FETCH_EMAILS: this._fmtGmailList.bind(this),  // Canonical Composio action
            GMAIL_LIST_MESSAGES: this._fmtGmailList.bind(this), // Alternative name
            GMAIL_GET_EMAIL: this._fmtGmailGet.bind(this),
            GMAIL_SEND_EMAIL: this._fmtGmailSend.bind(this),
            GMAIL_REPLY_TO_THREAD: this._fmtGmailReply.bind(this),
            GMAIL_REPLY_TO_EMAIL: this._fmtGmailReply.bind(this), // Legacy alias

            // Calendar
            GOOGLECALENDAR_EVENTS_LIST: this._fmtCalendarList.bind(this),
            GOOGLECALENDAR_FIND_EVENT: this._fmtCalendarList.bind(this),
            GOOGLECALENDAR_LIST_CALENDARS: this._fmtCalendarCalendarsList.bind(this),
            GOOGLECALENDAR_CREATE_EVENT: this._fmtCalendarCreate.bind(this),
            GOOGLECALENDAR_UPDATE_EVENT: this._fmtCalendarUpdate.bind(this),
            GOOGLECALENDAR_DELETE_EVENT: this._fmtCalendarDelete.bind(this),

            // Slack
            SLACK_SEND_MESSAGE: this._fmtSlackSend.bind(this),
            SLACK_LIST_CHANNELS: this._fmtSlackChannels.bind(this),
            SLACK_LIST_MESSAGES: this._fmtSlackMessages.bind(this),

            // Jira
            JIRA_CREATE_ISSUE: this._fmtJiraCreate.bind(this),
            JIRA_UPDATE_ISSUE: this._fmtJiraUpdate.bind(this),
            JIRA_GET_ISSUE: this._fmtJiraGet.bind(this),
            JIRA_JQL_SEARCH: this._fmtJiraSearch.bind(this),
            JIRA_SEARCH_ISSUES: this._fmtJiraSearch.bind(this),
            JIRA_SEARCH_FOR_ISSUES_USING_JQL_GET: this._fmtJiraSearch.bind(this),
            JIRA_SEARCH_FOR_ISSUES_USING_JQL_POST: this._fmtJiraSearch.bind(this),

            // GitHub (common)
            GITHUB_CREATE_ISSUE: this._fmtGitHubCreateIssue.bind(this),
            GITHUB_LIST_ISSUES: this._fmtGitHubListIssues.bind(this),
            GITHUB_SEARCH_ISSUES: this._fmtGitHubListIssues.bind(this),
            GITHUB_CREATE_PULL_REQUEST: this._fmtGitHubCreatePR.bind(this),
            GITHUB_LIST_PULL_REQUESTS: this._fmtGitHubListPRs.bind(this),
            GITHUB_GET_REPOSITORY: this._fmtGitHubRepo.bind(this),

            // System
            SYSTEM_CHECK_CONNECTIONS: this._fmtSystemConnections.bind(this),
        };
    }

    /**
     * Format a single action result.
     *
     * @param {string} actionName
     * @param {Object} rawResult - { success, data, error } or other wrapper shapes
     * @param {Object} context - { params, originalMessage, ... } optional
     * @param {Object} options - { timezone, useLLM } optional
     */
    async format(actionName, rawResult, context = {}, options = {}) {
        const action = safeString(actionName, "").trim();
        const actionUpper = action.toUpperCase();

        const timezone = options.timezone || this.defaultTimezone;
        const useLLM = options.useLLM === true || (options.useLLM === undefined && this.enableLLMByDefault);

        const norm = normalizeToolResult(rawResult);
        const service = actionToService(actionUpper);

        // Deterministic formatting
        const deterministic = this._formatDeterministic(actionUpper, norm, context, { timezone, service });

        // Optional LLM polish layer (never required, always fallback)
        if (useLLM && this.callLLM) {
            const polished = await this._polishWithLLM({
                action: actionUpper,
                service,
                deterministic,
                structured: deterministic.structured,
                timezone,
            });
            return polished || deterministic;
        }

        return deterministic;
    }

    // -----------------------------
    // Deterministic dispatcher
    // -----------------------------
    _formatDeterministic(actionUpper, norm, context, { timezone, service }) {
        const links = extractLinks(norm.payload);

        if (!norm.success) {
            const err = truncate(norm.error || "An error occurred.", 600);
            return {
                success: false,
                action: actionUpper,
                service,
                summary: `❌ ${this._humanActionName(actionUpper)} failed`,
                details: err,
                objectId: null,
                links,
                structured: { error: err },
                data: norm.raw,
            };
        }

        // Exact registry match
        const fn = this.registry[actionUpper];
        if (fn) {
            const out = fn(norm.payload, context, { timezone });
            return this._finalize(actionUpper, service, out, norm, links);
        }

        // Category fallback (covers Axonaut + unknown actions)
        const out = this._fallbackFormat(actionUpper, norm.payload, context, { timezone, service });
        return this._finalize(actionUpper, service, out, norm, links);
    }

    _finalize(actionUpper, service, out, norm, links) {
        const summary = truncate(out?.summary || `✅ ${this._humanActionName(actionUpper)} completed`, 280);
        const details = out?.details ? truncate(out.details, this.maxDetailsChars) : null;

        return {
            success: true,
            action: actionUpper,
            service,
            summary,
            details,
            objectId: out?.objectId || null,
            links: dedupeStrings([...(out?.links || []), ...(links || [])]),
            structured: out?.structured || {},
            data: norm.raw, // keep raw for debugging/tracing
        };
    }

    _humanActionName(actionUpper) {
        return safeString(actionUpper, "").toLowerCase().replace(/_/g, " ");
    }

    // -----------------------------
    // LLM polish
    // -----------------------------
    async _polishWithLLM({ action, service, deterministic, structured, timezone }) {
        try {
            const prompt = buildLLMPolishPrompt({ action, service, deterministic, structured, timezone });
            const text = await this.callLLM(prompt, "", this.llmTemperature);
            const parsed = safeJsonParse(text);

            if (!parsed || typeof parsed !== "object") return null;

            const summary = safeString(parsed.summary, "").trim();
            const details = safeString(parsed.details, "").trim();

            // Safety: must not be empty
            if (!summary) return null;

            // Preserve key facts: objectId and links should remain deterministic
            return {
                ...deterministic,
                summary: truncate(summary, 280),
                details: details ? truncate(details, this.maxDetailsChars) : deterministic.details,
            };
        } catch (_) {
            return null;
        }
    }

    // -----------------------------
    // Gmail
    // -----------------------------
    _fmtGmailList(payload, context) {
        const messages =
            pickFirstArray(payload, ["messages", "data.messages", "emails", "data.emails"]) ||
            [];

        if (!messages.length) {
            return { summary: "📧 No emails found.", details: null, structured: { count: 0, messages: [] } };
        }

        const lines = [];
        for (const msg of messages.slice(0, this.maxItems)) {
            // Support both normalized and Gmail-raw forms
            const headers = get(msg, "payload.headers", []);
            const subject =
                firstNonEmpty(
                    msg.subject,
                    headers?.find?.((h) => h?.name === "Subject")?.value,
                    msg.snippet ? truncate(msg.snippet, 50) : null,
                    "(No subject)"
                ) || "(No subject)";

            const from =
                firstNonEmpty(
                    msg.from,
                    headers?.find?.((h) => h?.name === "From")?.value,
                    msg.sender,
                    "Unknown"
                ) || "Unknown";

            const when =
                firstNonEmpty(msg.date, msg.internalDate, get(msg, "payload.headers", [])?.find?.((h) => h?.name === "Date")?.value) ||
                null;

            lines.push(`• **${truncate(subject, 70)}** — from ${truncate(normalizeEmailDisplay(from), 50)}${when ? ` (${truncate(when, 60)})` : ""}`);
        }

        const count = messages.length;
        return {
            summary: `📧 Found ${humanCount(count, "email")}`,
            details: lines.join("\n"),
            objectId: firstNonEmpty(messages[0]?.id, messages[0]?.messageId, null),
            structured: { count, messages: messages.slice(0, this.maxItems) },
        };
    }

    _fmtGmailGet(payload) {
        const subject = firstNonEmpty(payload.subject, "(No subject)");
        const from = firstNonEmpty(payload.from, payload.sender, "Unknown");
        const body = firstNonEmpty(payload.body, payload.snippet, payload.text, "");

        return {
            summary: `📧 ${truncate(subject, 90)}`,
            details: `**From:** ${truncate(from, 120)}\n\n${truncate(body, 900)}`,
            objectId: firstNonEmpty(payload.id, payload.messageId, null),
            structured: { subject, from, preview: truncate(body, 300) },
        };
    }

    _fmtGmailSend(payload, context) {
        const to = firstNonEmpty(get(context, "params.to"), get(context, "to"), null);
        const id = firstNonEmpty(payload.id, payload.messageId, null);

        return {
            summary: "✅ Email sent",
            details: to ? `Sent to: ${Array.isArray(to) ? to.join(", ") : to}` : null,
            objectId: id,
            structured: { messageId: id, to },
        };
    }

    _fmtGmailReply(payload) {
        const id = firstNonEmpty(payload.id, payload.messageId, null);
        return {
            summary: "✅ Reply sent",
            details: null,
            objectId: id,
            structured: { messageId: id },
        };
    }

    // -----------------------------
    // Calendar
    // -----------------------------
    _fmtCalendarCalendarsList(payload) {
        const items = pickFirstArray(payload, ["items", "calendars", "data.items", "data.calendars"]);
        if (!items.length) return { summary: "📅 No calendars found.", details: null, structured: { count: 0 } };

        const lines = items.slice(0, this.maxItems).map((c) => {
            const name = firstNonEmpty(c.summary, c.name, c.id, "(unnamed)");
            const primary = c.primary ? " (primary)" : "";
            const role = c.accessRole ? ` [${c.accessRole}]` : "";
            return `• ${truncate(name, 80)}${primary}${role}`;
        });

        return {
            summary: `📅 Found ${humanCount(items.length, "calendar")}`,
            details: lines.join("\n"),
            objectId: firstNonEmpty(items.find((x) => x.primary)?.id, items[0]?.id, null),
            structured: { count: items.length, calendars: items.slice(0, this.maxItems) },
        };
    }

    _fmtCalendarList(payload, context, { timezone }) {
        const events = pickFirstArray(payload, [
            "items",
            "events",
            "data.items",
            "data.events",
            "event_data.event_data",
            "data.event_data.event_data",
        ]);

        if (!events.length) {
            return { summary: "📅 No calendar events found.", details: null, structured: { count: 0, events: [] } };
        }

        const lines = [];
        for (const ev of events.slice(0, this.maxItems)) {
            const title = firstNonEmpty(ev.summary, ev.title, "(Untitled event)");
            const start = firstNonEmpty(get(ev, "start.dateTime"), get(ev, "start.date"), ev.start);
            const when = start ? formatDateTime(start, timezone) : "No time";
            lines.push(`• **${truncate(title, 80)}** — ${when}`);
        }

        return {
            summary: `📅 Found ${humanCount(events.length, "event")}`,
            details: lines.join("\n"),
            objectId: firstNonEmpty(events[0]?.id, null),
            links: dedupeStrings([events[0]?.htmlLink].filter(Boolean)),
            structured: { count: events.length, events: events.slice(0, this.maxItems) },
        };
    }

    _fmtCalendarCreate(payload, context, { timezone }) {
        const summary = firstNonEmpty(payload.summary, get(payload, "event_data.summary"), get(context, "params.summary"), "Event");
        const start =
            firstNonEmpty(
                get(payload, "start.dateTime"),
                get(payload, "start.date"),
                payload.startDateTime,
                payload.start_datetime,
                get(payload, "event_data.start.dateTime"),
                get(payload, "event_data.start.date"),
                get(context, "params.start_datetime"),
                get(context, "params.startDateTime"),
                null
            );

        const when = start ? formatDateTime(start, timezone) : "";
        const link = firstNonEmpty(payload.htmlLink, get(payload, "event_data.htmlLink"), null);
        const id = firstNonEmpty(payload.id, payload.eventId, get(payload, "event_data.id"), null);

        return {
            summary: `✅ Created calendar event "${truncate(summary, 70)}"`,
            details: when ? `Scheduled for: ${when}${link ? `\n${link}` : ""}` : (link ? link : null),
            objectId: id,
            links: link ? [link] : [],
            structured: { id, summary, start },
        };
    }

    _fmtCalendarUpdate(payload) {
        const summary = firstNonEmpty(payload.summary, "Event");
        const link = firstNonEmpty(payload.htmlLink, null);
        const id = firstNonEmpty(payload.id, null);
        return {
            summary: `✅ Updated calendar event "${truncate(summary, 70)}"`,
            details: link || null,
            objectId: id,
            links: link ? [link] : [],
            structured: { id, summary },
        };
    }

    _fmtCalendarDelete(_payload, context) {
        const id = firstNonEmpty(get(context, "params.event_id"), get(context, "event_id"), null);
        return {
            summary: "✅ Deleted calendar event",
            details: id ? `Event ID: ${id}` : null,
            objectId: id,
            structured: { id },
        };
    }

    // -----------------------------
    // Slack
    // -----------------------------
    _fmtSlackSend(payload, context) {
        const channel = firstNonEmpty(get(context, "params.channel"), payload.channel, payload.channel_id, "channel");
        const ts = firstNonEmpty(payload.ts, get(payload, "message.ts"), null);
        return {
            summary: `✅ Sent Slack message${channel ? ` to ${channel}` : ""}`,
            details: null,
            objectId: ts,
            structured: { channel, ts },
        };
    }

    _fmtSlackChannels(payload) {
        const channels = pickFirstArray(payload, ["channels", "data.channels", "items", "data.items"]);
        if (!channels.length) return { summary: "💬 No Slack channels found.", details: null, structured: { count: 0 } };

        const lines = channels.slice(0, this.maxItems).map((c) => {
            const name = firstNonEmpty(c.name, c.id, "unknown");
            const members = firstNonEmpty(c.num_members, c.members_count, null);
            return `• #${truncate(name, 60)}${members !== null ? ` (${members} members)` : ""}`;
        });

        return {
            summary: `💬 Found ${humanCount(channels.length, "channel")}`,
            details: lines.join("\n"),
            structured: { count: channels.length, channels: channels.slice(0, this.maxItems) },
        };
    }

    _fmtSlackMessages(payload) {
        const messages = pickFirstArray(payload, ["messages", "data.messages", "items", "data.items"]);
        if (!messages.length) return { summary: "💬 No Slack messages found.", details: null, structured: { count: 0 } };

        const lines = messages.slice(0, this.maxItems).map((m) => {
            const user = firstNonEmpty(m.user, m.username, "unknown");
            const text = truncate(firstNonEmpty(m.text, ""), 120);
            return `• [${truncate(user, 24)}] ${text}`;
        });

        return {
            summary: `💬 Found ${humanCount(messages.length, "message")}`,
            details: lines.join("\n"),
            structured: { count: messages.length, messages: messages.slice(0, this.maxItems) },
        };
    }

    // -----------------------------
    // Jira
    // -----------------------------
    _fmtJiraCreate(payload, context) {
        const key =
            firstNonEmpty(
                payload.key,
                payload.id,
                get(payload, "issue.key"),
                get(payload, "issue.id"),
                get(payload, "response.data.key"),
                get(context, "issue_key"),
                "NEW"
            );

        const summary = firstNonEmpty(get(context, "params.summary"), get(payload, "fields.summary"), payload.summary, "Issue");
        const url =
            firstNonEmpty(payload.browser_url, payload.url, payload.self, get(payload, "links.web"), null);

        return {
            summary: `✅ Created Jira issue **${truncate(key, 40)}**`,
            details: `**${truncate(key, 40)}**: ${truncate(summary, 140)}${url ? `\n${url}` : ""}`,
            objectId: key,
            links: url && looksLikeUrl(url) ? [url] : [],
            structured: { key, summary, url: url || null },
        };
    }

    _fmtJiraUpdate(_payload, context) {
        const key = firstNonEmpty(get(context, "params.issue_key"), get(context, "issue_key"), null);
        return {
            summary: `✅ Updated Jira issue${key ? ` ${key}` : ""}`,
            details: null,
            objectId: key,
            structured: { key },
        };
    }

    _fmtJiraSearch(payload) {
        // Composio often returns { issues: [...] } or { data: { issues: [...] } }
        let issues = pickFirstArray(payload, ["issues", "data.issues", "results", "data.results"]);
        if (!issues.length && Array.isArray(payload)) issues = payload;

        if (!issues.length) return { summary: "🎫 No Jira issues found.", details: null, structured: { count: 0, issues: [] } };

        const lines = issues.slice(0, this.maxItems).map((it) => {
            const key = firstNonEmpty(it.key, it.id, "UNKNOWN");
            const sum = firstNonEmpty(get(it, "fields.summary"), it.summary, "(No summary)");
            const status = firstNonEmpty(get(it, "fields.status.name"), get(it, "status.name"), "");
            const prio = firstNonEmpty(get(it, "fields.priority.name"), get(it, "priority.name"), "");
            return `• **${truncate(key, 24)}**: ${truncate(sum, 90)}${status ? ` [${truncate(status, 24)}]` : ""}${prio ? ` (P${truncate(prio, 12)})` : ""}`;
        });

        return {
            summary: `🎫 Found ${humanCount(issues.length, "issue")}`,
            details: lines.join("\n"),
            objectId: firstNonEmpty(issues[0]?.key, issues[0]?.id, null),
            structured: { count: issues.length, issues: issues.slice(0, this.maxItems) },
        };
    }

    _fmtJiraGet(payload) {
        const key = firstNonEmpty(payload.key, payload.id, "UNKNOWN");
        const summary = firstNonEmpty(get(payload, "fields.summary"), payload.summary, "Issue");
        const status = firstNonEmpty(get(payload, "fields.status.name"), get(payload, "status.name"), "Unknown");
        const assignee = firstNonEmpty(get(payload, "fields.assignee.displayName"), "Unassigned");
        const desc = firstNonEmpty(get(payload, "fields.description"), payload.description, "");
        const details = `**${truncate(key, 40)}: ${truncate(summary, 120)}**\nStatus: ${truncate(status, 40)}\nAssignee: ${truncate(assignee, 60)}${desc ? `\n\n${truncate(desc, 600)}` : ""}`;

        return {
            summary: `🎫 Jira issue ${truncate(key, 40)}`,
            details,
            objectId: key,
            structured: { key, summary, status, assignee },
        };
    }

    // -----------------------------
    // GitHub
    // -----------------------------
    _fmtGitHubCreateIssue(payload) {
        const number = firstNonEmpty(payload.number, get(payload, "issue.number"), null);
        const title = firstNonEmpty(payload.title, get(payload, "issue.title"), "Issue");
        const url = firstNonEmpty(payload.html_url, get(payload, "issue.html_url"), payload.url, null);

        return {
            summary: `✅ Created GitHub issue${number ? ` #${number}` : ""}: "${truncate(title, 80)}"`,
            details: url ? url : null,
            objectId: number ? `#${number}` : null,
            links: url && looksLikeUrl(url) ? [url] : [],
            structured: { number, title, url: url || null },
        };
    }

    _fmtGitHubListIssues(payload) {
        const issues = pickFirstArray(payload, ["items", "issues", "data.items", "data.issues", "results", "data.results"]);
        if (!issues.length && Array.isArray(payload)) return this._fmtGitHubListIssues({ items: payload });

        if (!issues.length) {
            return { summary: "🐙 No GitHub issues found.", details: null, structured: { count: 0, issues: [] } };
        }

        const lines = issues.slice(0, this.maxItems).map((it) => {
            const num = firstNonEmpty(it.number, null);
            const title = firstNonEmpty(it.title, "(No title)");
            const state = firstNonEmpty(it.state, "");
            return `• ${num ? `#${num} ` : ""}**${truncate(title, 90)}**${state ? ` [${state}]` : ""}`;
        });

        return {
            summary: `🐙 Found ${humanCount(issues.length, "issue")}`,
            details: lines.join("\n"),
            objectId: firstNonEmpty(issues[0]?.number ? `#${issues[0].number}` : null, null),
            structured: { count: issues.length, issues: issues.slice(0, this.maxItems) },
        };
    }

    _fmtGitHubCreatePR(payload) {
        const number = firstNonEmpty(payload.number, null);
        const title = firstNonEmpty(payload.title, "Pull request");
        const url = firstNonEmpty(payload.html_url, payload.url, null);

        return {
            summary: `✅ Created PR${number ? ` #${number}` : ""}: "${truncate(title, 80)}"`,
            details: url ? url : null,
            objectId: number ? `#${number}` : null,
            links: url && looksLikeUrl(url) ? [url] : [],
            structured: { number, title, url: url || null },
        };
    }

    _fmtGitHubListPRs(payload) {
        const prs = pickFirstArray(payload, ["items", "pulls", "pull_requests", "data.items", "data.pulls"]);
        if (!prs.length && Array.isArray(payload)) return this._fmtGitHubListPRs({ items: payload });

        if (!prs.length) return { summary: "🐙 No pull requests found.", details: null, structured: { count: 0 } };

        const lines = prs.slice(0, this.maxItems).map((pr) => {
            const num = firstNonEmpty(pr.number, null);
            const title = firstNonEmpty(pr.title, "(No title)");
            const state = firstNonEmpty(pr.state, "");
            return `• ${num ? `#${num} ` : ""}**${truncate(title, 90)}**${state ? ` [${state}]` : ""}`;
        });

        return {
            summary: `🐙 Found ${humanCount(prs.length, "pull request")}`,
            details: lines.join("\n"),
            objectId: prs[0]?.number ? `#${prs[0].number}` : null,
            structured: { count: prs.length, pullRequests: prs.slice(0, this.maxItems) },
        };
    }

    _fmtGitHubRepo(payload) {
        const fullName = firstNonEmpty(payload.full_name, payload.name, "repo");
        const url = firstNonEmpty(payload.html_url, null);
        const desc = firstNonEmpty(payload.description, "");
        return {
            summary: `🐙 Repo: ${truncate(fullName, 80)}`,
            details: `${desc ? truncate(desc, 200) + "\n" : ""}${url ? url : ""}`.trim() || null,
            objectId: fullName,
            links: url ? [url] : [],
            structured: { fullName, url: url || null },
        };
    }

    // -----------------------------
    // System
    // -----------------------------
    _fmtSystemConnections(payload) {
        const connections = firstNonEmpty(payload.connections, get(payload, "data.connections"), {}) || {};
        const toolkitsChecked = firstNonEmpty(payload.toolkitsChecked, Object.keys(connections), []);
        const missing = firstNonEmpty(payload.missing, []);

        const labelFor = (t) => {
            switch (safeString(t, "").toUpperCase()) {
                case "GOOGLECALENDAR": return "Google Calendar";
                case "GMAIL": return "Gmail";
                case "SLACK": return "Slack";
                case "JIRA": return "Jira";
                case "GITHUB": return "GitHub";
                case "AXONAUT": return "Axonaut";
                default: return safeString(t, "");
            }
        };

        const lines = [];
        for (const t of toolkitsChecked || []) {
            const c = connections?.[t] || {};
            const ok = !!c.connected;
            lines.push(`${ok ? "✅" : "❌"} ${labelFor(t)}${!ok && c.authUrl ? ` — Connect: ${c.authUrl}` : ""}`);
        }

        if (lines.length === 0) {
            return {
                summary: "No connected apps were found for your account.",
                details: "Open Integrations to connect an app, then ask me to check again.",
                structured: { connections, missing },
            };
        }

        return {
            summary: missing && missing.length ? "Some requested apps are not connected." : "Here are your connected apps.",
            details: lines.join("\n") || null,
            structured: { connections, missing },
        };
    }

    // -----------------------------
    // Axonaut (generic / resilient)
    // -----------------------------
    _fmtAxonautGeneric(actionUpper, payload) {
        const verb = classifyVerb(actionUpper);

        // common patterns: payload.items, payload.data.items, payload.results, payload.contacts, payload.companies, etc.
        const list = pickFirstArray(payload, [
            "items",
            "data.items",
            "results",
            "data.results",
            "contacts",
            "data.contacts",
            "companies",
            "data.companies",
            "projects",
            "data.projects",
            "invoices",
            "data.invoices",
            "opportunities",
            "data.opportunities",
        ]);

        const id = firstNonEmpty(payload.id, payload.uuid, payload.number, get(payload, "data.id"), get(payload, "data.uuid"), null);
        const name = firstNonEmpty(payload.name, payload.title, payload.label, payload.reference, get(payload, "data.name"), null);

        if (verb === "list" || verb === "get") {
            if (!list.length) {
                return { summary: "🧾 No Axonaut records found.", details: null, structured: { count: 0 } };
            }
            const lines = list.slice(0, this.maxItems).map((it) => {
                const itId = firstNonEmpty(it.id, it.uuid, it.number, "");
                const itName = firstNonEmpty(it.name, it.title, it.label, it.reference, "(unnamed)");
                return `• ${itId ? `(${itId}) ` : ""}${truncate(itName, 90)}`;
            });
            return {
                summary: `🧾 Found ${humanCount(list.length, "record")}`,
                details: lines.join("\n"),
                objectId: firstNonEmpty(list[0]?.id, list[0]?.uuid, list[0]?.number, null),
                structured: { count: list.length, items: list.slice(0, this.maxItems) },
            };
        }

        if (verb === "create") {
            return {
                summary: `✅ Created Axonaut record${name ? ` "${truncate(name, 70)}"` : ""}`,
                details: id ? `ID: ${id}` : null,
                objectId: id,
                structured: { id, name: name || null },
            };
        }

        if (verb === "update") {
            return {
                summary: `✅ Updated Axonaut record${id ? ` (${id})` : ""}`,
                details: name ? `Name: ${truncate(name, 90)}` : null,
                objectId: id,
                structured: { id, name: name || null },
            };
        }

        if (verb === "delete") {
            return {
                summary: `✅ Deleted Axonaut record${id ? ` (${id})` : ""}`,
                details: null,
                objectId: id,
                structured: { id },
            };
        }

        return null;
    }

    // -----------------------------
    // Fallback formatter (unknown actions + Axonaut)
    // -----------------------------
    _fallbackFormat(actionUpper, payload, context, { timezone, service }) {
        // Axonaut special fallback
        if (service === "axonaut") {
            const ax = this._fmtAxonautGeneric(actionUpper, payload, context, { timezone });
            if (ax) return ax;
        }

        const verb = classifyVerb(actionUpper);
        const links = extractLinks(payload);

        // Try to detect list-like payloads
        const list = Array.isArray(payload)
            ? payload
            : pickFirstArray(payload, ["items", "data.items", "results", "data.results", "data", "rows", "data.rows"]);

        if ((verb === "list" || verb === "get") && Array.isArray(list) && list.length) {
            const lines = list.slice(0, this.maxItems).map((it) => {
                const id = firstNonEmpty(it.id, it.key, it.number, it.uuid, "");
                const title = firstNonEmpty(it.summary, it.title, it.name, it.subject, "(item)");
                return `• ${id ? `(${id}) ` : ""}${truncate(title, 90)}`;
            });

            return {
                summary: `✅ ${this._humanActionName(actionUpper)}: found ${list.length}`,
                details: lines.join("\n"),
                objectId: firstNonEmpty(list[0]?.id, list[0]?.key, list[0]?.number, null),
                links,
                structured: { count: list.length },
            };
        }

        // Create/update defaults
        const id = firstNonEmpty(payload?.id, payload?.key, payload?.number, payload?.uuid, null);
        const title = firstNonEmpty(payload?.summary, payload?.title, payload?.name, payload?.subject, null);

        return {
            summary: `✅ ${this._humanActionName(actionUpper)} completed`,
            details: title ? truncate(title, 300) : (id ? `ID: ${id}` : null),
            objectId: id,
            links,
            structured: { id: id || null, title: title || null },
        };
    }
}

module.exports = { ActionResultFormatter };
