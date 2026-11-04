import React, { useEffect, useState } from 'react';
import { organizationApi } from '../services/api';

const roleLabels = { owner: 'Owner', admin: 'Admin', member: 'Member', viewer: 'Viewer' };

export default function OrganizationTeamPanel({ organizations, activeOrganization, setActiveOrganization, onClose }) {
  const [members, setMembers] = useState([]);
  const [invitations, setInvitations] = useState([]);
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState('member');
  const [previewUrl, setPreviewUrl] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const role = activeOrganization?.role;
  const canManage = role === 'owner' || role === 'admin';

  const loadTeam = async () => {
    if (!activeOrganization) return;
    try {
      setError('');
      const [memberData, invitationData] = await Promise.all([
        organizationApi.members(activeOrganization.organization_id),
        canManage
          ? organizationApi.invitations(activeOrganization.organization_id)
          : Promise.resolve({ invitations: [] }),
      ]);
      setMembers(memberData.members || []);
      setInvitations(invitationData.invitations || []);
    } catch (err) {
      setError(err.message);
    }
  };

  useEffect(() => {
    loadTeam();
  }, [activeOrganization?.organization_id, canManage]);

  const invite = async (event) => {
    event.preventDefault();
    try {
      setBusy(true);
      setError('');
      setNotice('');
      setPreviewUrl('');
      const data = await organizationApi.invite(activeOrganization.organization_id, {
        email: inviteEmail,
        role: inviteRole,
      });
      setInviteEmail('');
      setNotice(data.delivery?.delivered
        ? 'Invitation email sent.'
        : 'Local invitation created. Use the test link below.');
      setPreviewUrl(data.delivery?.previewUrl || '');
      await loadTeam();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const changeRole = async (userId, nextRole) => {
    try {
      setBusy(true);
      setError('');
      await organizationApi.updateMemberRole(activeOrganization.organization_id, userId, nextRole);
      setNotice('Member role updated.');
      await loadTeam();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const resend = async (invitationId) => {
    try {
      setBusy(true);
      setError('');
      setPreviewUrl('');
      const data = await organizationApi.resendInvitation(activeOrganization.organization_id, invitationId);
      setNotice(data.delivery?.delivered ? 'Invitation sent again.' : 'Invitation renewed. Use the new test link below.');
      setPreviewUrl(data.delivery?.previewUrl || '');
      await loadTeam();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (userId) => {
    if (!window.confirm('Remove this person from the organization?')) return;
    try {
      setBusy(true);
      setError('');
      await organizationApi.removeMember(activeOrganization.organization_id, userId);
      setNotice('Member removed.');
      await loadTeam();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (invitationId) => {
    try {
      setBusy(true);
      setError('');
      await organizationApi.revokeInvitation(activeOrganization.organization_id, invitationId);
      setNotice('Invitation revoked.');
      await loadTeam();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[70] bg-black/70 backdrop-blur-sm p-4 overflow-y-auto">
      <section className="max-w-3xl mx-auto my-8 bg-gray-900 border border-blue-500/30 rounded-2xl p-6 text-white shadow-2xl">
        <div className="flex justify-between gap-4 mb-5">
          <div><h2 className="text-xl font-bold">Organization &amp; Team</h2><p className="text-sm text-gray-400">Manage access to this organization.</p></div>
          <button onClick={onClose} className="text-gray-300 hover:text-white">Close</button>
        </div>

        {organizations.length > 1 && (
          <label className="block mb-4 text-sm text-gray-300">Active organization
            <select value={activeOrganization?.organization_id || ''} onChange={event => setActiveOrganization(organizations.find(item => item.organization_id === event.target.value))} className="block mt-1 w-full bg-gray-800 border border-gray-600 rounded p-2 text-white">
              {organizations.map(item => <option key={item.organization_id} value={item.organization_id}>{item.organization_name} — {roleLabels[item.role]}</option>)}
            </select>
          </label>
        )}

        <div className="mb-5 p-4 bg-blue-500/10 border border-blue-500/30 rounded-lg">
          <p className="font-semibold">{activeOrganization?.organization_name || 'No organization selected'}</p>
          <p className="text-sm text-blue-200">Your role: {roleLabels[role] || 'Unknown'}</p>
        </div>

        {error && <div className="mb-4 p-3 bg-red-900/30 text-red-200 rounded">{error}</div>}
        {notice && <div className="mb-4 p-3 bg-green-900/30 text-green-200 rounded">{notice}</div>}

        {canManage && (
          <form onSubmit={invite} className="mb-6 p-4 border border-gray-700 rounded-lg">
            <p className="font-semibold mb-3">Invite a teammate</p>
            <div className="grid md:grid-cols-3 gap-3">
              <input required type="email" value={inviteEmail} onChange={event => setInviteEmail(event.target.value)} placeholder="person@company.com" className="bg-gray-800 border border-gray-600 rounded p-2 text-white" />
              <select value={inviteRole} onChange={event => setInviteRole(event.target.value)} className="bg-gray-800 border border-gray-600 rounded p-2 text-white">
                <option value="member">Member</option><option value="viewer">Viewer</option>{role === 'owner' && <option value="admin">Admin</option>}
              </select>
              <button disabled={busy} className="bg-blue-600 hover:bg-blue-500 disabled:opacity-50 rounded px-3 py-2">{busy ? 'Working…' : 'Send invitation'}</button>
            </div>
          </form>
        )}

        {previewUrl && <div className="mb-5 p-3 bg-amber-500/10 border border-amber-400/30 rounded text-amber-100 text-sm break-all">Development test link: <a className="underline" href={previewUrl}>{previewUrl}</a></div>}

        <h3 className="font-semibold mb-3">Team members</h3>
        <div className="space-y-2 mb-7">
          {members.map(member => (
            <div key={member.id} className="flex items-center justify-between gap-3 border border-gray-800 rounded-lg p-3">
              <div><p>{member.name || member.email}</p><p className="text-xs text-gray-400">{member.email}</p></div>
              {member.role === 'owner'
                ? <span className="text-sm text-amber-300">Owner</span>
                : canManage
                  ? <div className="flex items-center gap-2"><select disabled={busy || (role === 'admin' && member.role === 'admin')} value={member.role} onChange={event => changeRole(member.id, event.target.value)} className="bg-gray-800 border border-gray-600 rounded p-1 text-sm disabled:opacity-60"><option value="member">Member</option><option value="viewer">Viewer</option>{role === 'owner' && <option value="admin">Admin</option>}</select><button disabled={busy || (role === 'admin' && member.role === 'admin')} onClick={() => remove(member.id)} className="text-xs text-red-300 hover:text-red-200 disabled:opacity-40">Remove</button></div>
                  : <span className="text-sm text-gray-300">{roleLabels[member.role]}</span>}
            </div>
          ))}
        </div>

        {canManage && (
          <>
            <h3 className="font-semibold mb-3">Pending invitations</h3>
            {invitations.length === 0 && <p className="text-sm text-gray-400">No pending invitations.</p>}
            <div className="space-y-2">
              {invitations.map(invitation => (
                <div key={invitation.id} className="flex flex-wrap items-center justify-between gap-3 border border-gray-800 rounded-lg p-3">
                  <div><p>{invitation.email}</p><p className="text-xs text-gray-400">{roleLabels[invitation.role]} · expires {new Date(invitation.expires_at).toLocaleDateString()}</p></div>
                  <div className="flex gap-2">
                    <button disabled={busy || (role === 'admin' && invitation.role === 'admin')} onClick={() => resend(invitation.id)} className="px-3 py-1.5 rounded bg-gray-700 hover:bg-gray-600 disabled:opacity-50 text-sm">Resend</button>
                    <button disabled={busy || (role === 'admin' && invitation.role === 'admin')} onClick={() => revoke(invitation.id)} className="px-3 py-1.5 rounded bg-red-900/50 hover:bg-red-800/60 disabled:opacity-50 text-red-100 text-sm">Revoke</button>
                  </div>
                </div>
              ))}
            </div>
          </>
        )}
      </section>
    </div>
  );
}
