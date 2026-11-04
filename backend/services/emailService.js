const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function assertEmail(email) {
  const normalized = String(email || '').trim().toLowerCase();
  if (!EMAIL_PATTERN.test(normalized)) throw new Error('A valid email address is required');
  return normalized;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;',
  })[character]);
}

const ROLE_DESCRIPTIONS = {
  admin: 'manage members, organization settings, and permitted workflows',
  member: 'use connected tools and run permitted AI-assisted workflows',
  viewer: 'view organization activity and results without performing write actions',
};

async function sendOrganizationInvitation({
  email,
  organizationName,
  invitationUrl,
  inviterName,
  role,
  expiresAt,
}) {
  const recipient = assertEmail(email);
  const apiKey = process.env.RESEND_API_KEY;

  if (!apiKey) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('Invitation email is not configured');
    }
    return { delivered: false, previewUrl: invitationUrl };
  }

  const from = process.env.EMAIL_FROM;
  if (!from) throw new Error('EMAIL_FROM is required to send invitation email');

  const safeOrganization = escapeHtml(organizationName);
  const safeInvitationUrl = escapeHtml(invitationUrl);
  const safeInviter = escapeHtml(inviterName || 'An organization administrator');
  const normalizedRole = ROLE_DESCRIPTIONS[role] ? role : 'member';
  const roleLabel = normalizedRole.charAt(0).toUpperCase() + normalizedRole.slice(1);
  const roleDescription = ROLE_DESCRIPTIONS[normalizedRole];
  const expiryDate = expiresAt
    ? new Intl.DateTimeFormat('en', { dateStyle: 'long', timeZone: 'UTC' }).format(new Date(expiresAt))
    : '7 days from now';
  const supportEmail = assertEmail(process.env.SUPPORT_EMAIL || 'support@swiftcollab.tech');
  const subject = `${inviterName || 'An organization administrator'} invited you to ${organizationName} on SwiftCollab`;
  const text = [
    `You have been invited to join ${organizationName} on SwiftCollab.`,
    `${inviterName || 'An organization administrator'} assigned you the ${roleLabel} role.`,
    `As a ${roleLabel}, you can ${roleDescription}.`,
    `Accept your invitation: ${invitationUrl}`,
    `This invitation expires on ${expiryDate} and can only be accepted by ${recipient}.`,
    `If you were not expecting this invitation, ignore this email or contact ${supportEmail}.`,
  ].join('\n\n');

  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from,
      to: [recipient],
      subject,
      text,
      html: `<div style="background:#f3f4f6;padding:32px 16px;font-family:Arial,sans-serif;color:#111827"><div style="max-width:560px;margin:auto;background:#ffffff;border:1px solid #e5e7eb;border-radius:14px;overflow:hidden"><div style="background:#111827;padding:22px 28px;color:#ffffff"><div style="font-size:22px;font-weight:700">Swift<span style="color:#60a5fa">Collab</span></div><div style="margin-top:4px;color:#cbd5e1;font-size:13px">AI-powered multi-app orchestration</div></div><div style="padding:28px"><h1 style="font-size:23px;margin:0 0 16px">Join ${safeOrganization}</h1><p style="line-height:1.6;margin:0 0 14px"><strong>${safeInviter}</strong> invited you to collaborate in <strong>${safeOrganization}</strong>.</p><div style="background:#eff6ff;border:1px solid #bfdbfe;border-radius:9px;padding:14px;margin:18px 0"><div style="font-weight:700;color:#1d4ed8">Your role: ${roleLabel}</div><div style="font-size:14px;line-height:1.5;margin-top:5px;color:#374151">You can ${roleDescription}.</div></div><p style="margin:22px 0"><a href="${safeInvitationUrl}" style="display:inline-block;padding:12px 18px;background:#2563eb;color:#ffffff;text-decoration:none;border-radius:8px;font-weight:700">Accept invitation</a></p><p style="font-size:13px;line-height:1.6;color:#6b7280">This secure invitation expires on ${expiryDate} and can only be accepted using <strong>${escapeHtml(recipient)}</strong>.</p><p style="font-size:13px;line-height:1.6;color:#6b7280">If you were not expecting this invitation, ignore this email or contact <a href="mailto:${escapeHtml(supportEmail)}" style="color:#2563eb">${escapeHtml(supportEmail)}</a>.</p></div></div></div>`,
    }),
  });
  if (!response.ok) {
    const providerBody = await response.text();
    let providerMessage = providerBody;
    try {
      const parsed = JSON.parse(providerBody);
      providerMessage = parsed.message || parsed.name || providerBody;
    } catch {
      // Resend occasionally returns a non-JSON gateway response.
    }
    console.error('[Email] Invitation delivery failed:', response.status, providerMessage);
    const safeMessage = process.env.NODE_ENV === 'production'
      ? 'Unable to send invitation email'
      : `Unable to send invitation email: ${providerMessage}`;
    const error = new Error(safeMessage);
    error.statusCode = response.status;
    throw error;
  }
  const result = await response.json();
  return { delivered: true, messageId: result.id };
}

module.exports = { assertEmail, escapeHtml, sendOrganizationInvitation };
