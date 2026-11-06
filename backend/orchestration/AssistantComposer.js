/**
 * AssistantComposer
 *
 * Single response formatting layer used across the codebase.
 *
 * - Deterministic formatting first (ActionResultFormatter + structure detection).
 * - Optional LLM pass for nicer wording (never required).
 * - Exposes a static `composeByDataStructure()` for Temporal/code paths that need
 *   action-agnostic formatting.
 */

const { ActionResultFormatter } = require("./core/ActionResultFormatter");
const { getToolError, isToolSuccess } = require("./core/ToolUtils");
const { formatTypedInjection } = require("./core/TypedInjection");

function unwrapToolPayload(stepData) {
  // ExecutorV2 tool step data is typically { successful, data, error, ... }
  if (!stepData) return null;
  if (typeof stepData !== "object") return stepData;
  if ("data" in stepData) return stepData.data;
  return stepData;
}

function extractArray(data, paths) {
  for (const path of paths) {
    const parts = path.split(".");
    let cur = data;
    let ok = true;
    for (const p of parts) {
      if (!cur || typeof cur !== "object" || !(p in cur)) {
        ok = false;
        break;
      }
      cur = cur[p];
    }
    if (ok && Array.isArray(cur)) return cur;
  }
  return null;
}

class AssistantComposer {
  constructor({ callGemini } = {}) {
    this.callGemini = callGemini || null;
    // Pass LLM function to ActionResultFormatter for optional polish layer
    this.resultFormatter = new ActionResultFormatter({ callLLM: callGemini });
  }

  async composeChat({ message, conversationHistory = [] }) {
    if (!this.callGemini) {
      return "I can help with calendar, email, Slack, Jira, and more. What would you like to do?";
    }

    const systemPrompt = `You are a friendly AI assistant for SwiftCollab, a productivity platform that helps users manage their work across multiple apps.

Be conversational, helpful, and concise (2-3 sentences).
This is chat-only mode: no connected-app action is being executed. Never claim that an issue, email, event, or other external record was created or updated. Never emit tool-call JSON. If the user is trying to continue an app action, clearly say that it has not been executed and ask them to restate the complete action with the record identifier.`;

    const historyContext =
      conversationHistory.length > 0
        ? `\n\nRecent conversation:\n${conversationHistory
          .slice(-5)
          .map((m) => `${m.role}: ${m.text}`)
          .join("\n")}`
        : "";

    try {
      const response = await this.callGemini(systemPrompt + historyContext, message, 0.7);
      return String(response || "").trim() || "How can I help?";
    } catch (error) {
      console.warn('[AssistantComposer] Chat model unavailable:', error.message);
      return "I can help answer questions or work with your connected apps. What would you like to do?";
    }
  }

  async composeExecution({ originalMessage, executionResult, timezone = "America/New_York" }) {
    const deterministic = this.composeExecutionDeterministic({ executionResult, timezone });

    if (!this.callGemini) return deterministic;

    const results = executionResult?.results || [];
    const successful = results.filter((r) => r && r.success);
    const failed = results.filter((r) => r && !r.success);

    const prompt = `You are a helpful assistant. Write a concise confirmation of what was done.

USER REQUEST:
"${String(originalMessage || "")}"

SUCCESSFUL STEPS (count=${successful.length}):
${successful.map((r) => `- ${r.action}: ${r.formattedOutput || ""}`).join("\n")}

FAILED STEPS (count=${failed.length}):
${failed.map((r) => `- ${r.action}: ${r.error || ""}`).join("\n")}

RULES:
1) Be concise (2-4 sentences).
2) Focus on outcomes; include IDs/links when available.
3) If something failed, mention it briefly and suggest what to provide next.
4) Return ONLY the response text.`;

    try {
      const response = await this.callGemini(prompt, "", 0.3);
      const text = String(response || "").trim();
      return text || deterministic;
    } catch (_) {
      return deterministic;
    }
  }

  async composeExecutionDeterministic({ executionResult, timezone = "America/New_York" }) {
    const results = executionResult?.results || [];
    const successful = results.filter((r) => r && r.success);
    const failed = results.filter((r) => r && !r.success);

    if (successful.length === 0 && failed.length > 0) {
      const first = failed[0];
      return `I couldn't complete that. ${first.error || "Something went wrong."}`.trim();
    }

    const lines = [];

    for (const step of successful) {
      const action = step.action || "task";
      const stepData = step.data;

      // 1) Action-specific formatter (best)
      const payload = unwrapToolPayload(stepData);
      const formatted = await this.resultFormatter.format(action, {
        success: true,
        data: payload,
        error: null,
      }, {}, { timezone });
      if (formatted?.summary) {
        // Include both summary AND details (details has the actual list of events/issues)
        if (formatted.details) {
          lines.push(`${formatted.summary}\n\n${formatted.details}`);
        } else {
          lines.push(formatted.summary);
        }
        continue;
      }

      // 2) Structure-based (good)
      const structure = AssistantComposer.composeByDataStructure(payload, { timezone });
      if (structure) {
        lines.push(structure);
        continue;
      }

      // 3) Typed compact fallback
      lines.push(
        `Completed ${action}: ${formatTypedInjection({
          data: payload,
          sourceAction: action,
          targetAction: action,
          targetParam: "output",
          limits: { maxChars: 800 },
        })}`
      );
    }

    if (failed.length > 0) {
      lines.push(`Failed: ${failed.map((f) => f.error || "Unknown error").join("; ")}`);
    }

    return lines.filter(Boolean).join("\n");
  }

  /**
   * Action-agnostic formatting (used in Temporal activities too).
   * Returns a string or null if structure is unknown.
   */
  static composeByDataStructure(data, { timezone = "America/New_York" } = {}) {
    if (!data || typeof data !== "object") return null;

    const items = extractArray(data, ["items", "data.items", "events", "data.events", "data.event_data.event_data"]);
    if (items && items.length > 0) {
      const sample = items[0] || {};

      // Calendar LIST (items have accessRole but no start field - these are calendars, not events)
      if (sample.accessRole && !sample.start) {
        const lines = ["📅 Your calendars:"];
        for (const cal of items.slice(0, 10)) {
          const name = cal.summary || cal.id || "(unnamed)";
          const primary = cal.primary ? " (primary)" : "";
          const role = cal.accessRole === "owner" ? "" : ` [${cal.accessRole}]`;
          lines.push(`- ${name}${primary}${role}`);
        }
        return lines.join("\n");
      }

      // Calendar EVENTS (items have start field)
      if (sample.start || sample.summary || sample.htmlLink) {
        if (items.length === 0) return "📅 No calendar events found.";

        const lines = ["📅 Your events:"];
        for (const e of items.slice(0, 10)) {
          const title = e.summary || e.title || "(no title)";
          const start = e.start?.dateTime || e.start?.date || e.start_datetime || e.start || null;
          let timeStr = "";
          if (start) {
            try {
              timeStr = new Date(start).toLocaleString("en-US", {
                timeZone: timezone,
                hour: "numeric",
                minute: "2-digit",
              });
            } catch (_) { }
          }
          lines.push(`- ${title}${timeStr ? ` (${timeStr})` : ""}`);
        }
        return lines.join("\n");
      }
    }

    // Empty calendar events
    if (items && items.length === 0) {
      // Check if this looks like a calendar response (has kind or etag)
      if (data.kind?.includes("calendar") || data.data?.kind?.includes("calendar")) {
        return "📅 No calendar events found.";
      }
    }

    const emails = extractArray(data, ["messages", "data.messages", "emails", "data.emails"]);
    if (emails) {
      if (emails.length === 0) return "No emails found.";
      const lines = ["Emails:"];
      for (const m of emails.slice(0, 10)) {
        const subject = m.subject || m.snippet || "(no subject)";
        const from = m.from || m.sender || "Unknown sender";
        lines.push(`- ${subject} — ${from}`);
      }
      return lines.join("\n");
    }

    const issues = extractArray(data, ["issues", "data.issues"]);
    if (issues) {
      if (issues.length === 0) return "No Jira tickets found.";
      const lines = ["Jira:"];
      for (const issue of issues.slice(0, 10)) {
        const key = issue.key || issue.id || "UNKNOWN";
        const summary = issue.fields?.summary || issue.summary || "(no summary)";
        lines.push(`- ${key}: ${summary}`);
      }
      return lines.join("\n");
    }

    return null;
  }

  /**
   * Normalize an ExecutorV2 step result into legacy {success, action, data, error}.
   */
  static toLegacyResult(step) {
    const action = step?.action || null;
    const toolResult = step?.data;
    const success = !!step?.success;
    const payload = unwrapToolPayload(toolResult);
    const error = success ? null : step?.error || getToolError(toolResult) || null;

    return { success, action, data: payload, error };
  }

  static extractToolError(stepData) {
    if (!stepData) return null;
    if (typeof stepData === "string") return stepData;
    if (typeof stepData === "object") return getToolError(stepData);
    return String(stepData);
  }

  static extractToolSuccess(stepData) {
    return isToolSuccess(stepData);
  }

  /**
   * Generate a nice, human-friendly confirmation message before executing actions.
   * Uses LLM to create natural language instead of technical action names.
   * Enhanced to:
   * - Group actions by type (email, calendar, slack, etc.)
   * - Show clear details for each action
   * - Invite the user to make corrections or skip actions
   *
   * @param {object} options
   * @param {string} options.originalMessage - The user's original request
   * @param {Array} options.tools - Tools that will be executed
   * @param {object} options.sideEffects - Side effects summary (if any)
   * @param {string} options.timezone - User's timezone
   * @returns {Promise<string>} - Human-friendly confirmation message
   */
  async composeConfirmationMessage({ originalMessage, tools, sideEffects, timezone = "America/New_York" }) {
    // Build deterministic fallback first
    const deterministicMsg = this._buildDeterministicConfirmation(tools, sideEffects);

    if (!this.callGemini) {
      console.log('[AssistantComposer] No callGemini function, using deterministic confirmation');
      return deterministicMsg;
    }

    console.log('[AssistantComposer] Using LLM for confirmation message');

    // Group tools by category for clearer presentation
    const grouped = this._groupToolsByCategory(tools, timezone);

    const prompt = `You are a casual AI assistant. Write a SHORT, natural confirmation.

USER SAID: "${originalMessage || 'do this'}"

WHAT HAPPENS:
${grouped.map((g) => `${g.emoji} ${g.description}`).join('\n')}

STYLE:
- Be CASUAL like texting a friend
- NO robotic phrases: "I'll", "I'm going to", "I'm ready to proceed"
- Just list what happens, present tense
- Keep it SHORT (2-4 lines)
- End with "Ready?" or "Confirm?" or "Sound good?"

BAD EXAMPLE (too robotic):
"I'll search for tickets in Jira. I'll schedule a Meeting for you."

GOOD EXAMPLE:
"📅 Meeting with john@test.com at 3pm today
🎫 Including Jira tickets in the description

Ready?"

Write ONLY the message.`;

    try {
      console.log('[AssistantComposer] Calling LLM for confirmation with grouped tools:', JSON.stringify(grouped.map(g => g.category + ':' + g.description)));
      const response = await this.callGemini(prompt, "", 0.4);
      console.log('[AssistantComposer] LLM response received, length:', String(response || "").length);
      let text = String(response || "").trim();

      if (!text) {
        console.warn('[AssistantComposer] LLM returned empty response, using fallback');
        return deterministicMsg;
      }

      // Ensure it has a question/invitation at the end
      if (text && !text.includes('?') && !text.toLowerCase().includes('skip') && !text.toLowerCase().includes('change')) {
        text += "\n\nSound good? (You can say 'yes', make changes, or skip specific actions)";
      }

      console.log('[AssistantComposer] Final confirmation message generated successfully');
      return text;
    } catch (err) {
      console.error('[AssistantComposer] LLM confirmation FAILED:', err.message, err.stack);
      return deterministicMsg;
    }
  }

  /**
   * Group tools by category for clearer confirmation messages
   */
  _groupToolsByCategory(tools, timezone) {
    const groups = [];

    for (const t of (tools || [])) {
      const action = (t.composio_action || t.name || '').toUpperCase();
      const params = t.params || {};

      let category = 'Action';
      let emoji = '⚡';
      let description = '';

      // Email
      if (action.includes('GMAIL') || action.includes('EMAIL')) {
        emoji = '📧';
        category = 'Email';
        const to = Array.isArray(params.to) ? params.to.join(', ') : params.to;
        const subject = params.subject || '';
        description = `Send to ${to || 'recipient'}`;
        if (subject) description += ` - "${subject}"`;
      }
      // Calendar
      else if (action.includes('CALENDAR') || action.includes('EVENT')) {
        emoji = '📅';
        category = 'Calendar';
        const summary = params.summary || 'Meeting';
        let timeStr = '';
        if (params.start_datetime) {
          try {
            const date = new Date(params.start_datetime);
            timeStr = date.toLocaleString('en-US', {
              timeZone: timezone,
              weekday: 'short',
              month: 'short',
              day: 'numeric',
              hour: 'numeric',
              minute: '2-digit'
            });
          } catch (_) { }
        }
        const attendees = params.attendees ?
          (Array.isArray(params.attendees) ? params.attendees.map(a => a.email || a).join(', ') : params.attendees) : '';

        description = `"${summary}"`;
        if (timeStr) description += ` on ${timeStr}`;
        if (attendees) description += ` with ${attendees}`;
      }
      // Slack
      else if (action.includes('SLACK')) {
        emoji = '💬';
        category = 'Slack';
        const channel = params.channel || params.channel_name || '';
        description = channel ? `Post to #${channel}` : 'Send message';
      }
      // Jira
      else if (action.includes('JIRA')) {
        emoji = '🎫';
        category = 'Jira';
        if (action.includes('CREATE')) {
          description = `Create ticket: "${params.summary || 'New issue'}"`;
        } else if (action.includes('SEARCH') || action.includes('GET')) {
          description = 'Search tickets';
        } else {
          description = 'Update Jira';
        }
      }
      // Trello/Asana/etc
      else if (action.includes('TRELLO') || action.includes('ASANA')) {
        emoji = '📋';
        category = 'Task';
        description = params.name || params.title || 'Manage task';
      }
      // Zoom
      else if (action.includes('ZOOM')) {
        emoji = '🎥';
        category = 'Zoom';
        description = 'Create meeting link';
      }
      // Default
      else {
        description = t.name || action.toLowerCase().replace(/_/g, ' ');
      }

      groups.push({ emoji, category, description, action: t.name || action });
    }

    return groups;
  }


  /**
   * Deterministic (non-LLM) confirmation message builder
   */
  _buildDeterministicConfirmation(tools, sideEffects) {
    const count = (tools || []).length;
    if (count === 0) return "Nothing to do. Proceed?";

    // Try to make it more human-readable
    const actionTypes = (tools || []).map(t => {
      const action = (t.composio_action || t.name || '').toLowerCase();
      if (action.includes('send_email') || action.includes('gmail_send')) return 'send an email';
      if (action.includes('create_event') || action.includes('calendar')) return 'create a calendar event';
      if (action.includes('search') || action.includes('fetch')) return 'search for data';
      if (action.includes('slack')) return 'send a Slack message';
      if (action.includes('jira')) return 'interact with Jira';
      return t.name || 'perform an action';
    });

    const unique = [...new Set(actionTypes)];
    if (unique.length === 1) {
      return `I'll ${unique[0]}. Ready to proceed? (yes/no)`;
    }
    if (unique.length <= 3) {
      const last = unique.pop();
      return `I'll ${unique.join(', ')} and ${last}. Ready to proceed? (yes/no)`;
    }
    return `I'll perform ${count} actions. Ready to proceed? (yes/no)`;
  }
}

module.exports = AssistantComposer;

