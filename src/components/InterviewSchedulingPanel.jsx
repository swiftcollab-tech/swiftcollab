import React, { useEffect, useState } from 'react';
import { googleWorkspaceApi, interviewSchedulingApi } from '../services/api';

function eventLabel(execution) {
  const candidate = execution.source_snapshot?.candidate_name || 'Interview';
  const time = execution.requested_start ? new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(execution.requested_start)) : '';
  return `${candidate}${time ? ` · ${time}` : ''}`;
}

export default function InterviewSchedulingPanel({ onClose }) {
  const [automation, setAutomation] = useState(null);
  const [googleStatus, setGoogleStatus] = useState(null);
  const [configuration, setConfiguration] = useState(null);
  const [sheetLink, setSheetLink] = useState('');
  const [sheetRange, setSheetRange] = useState('Sheet1!A:G');
  const [timezone, setTimezone] = useState('UTC');
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState(false);
  const [historyHidden, setHistoryHidden] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const refresh = async () => {
    setError('');
    try {
      const [automationData, googleData, configurationData] = await Promise.all([interviewSchedulingApi.getAutomation(), googleWorkspaceApi.status(), interviewSchedulingApi.getConfiguration()]);
      setAutomation(automationData);
      setGoogleStatus(googleData);
      const config = configurationData.configuration || {};
      setConfiguration(config);
      setSheetLink(config.spreadsheet_id || '');
      setSheetRange(config.sheet_range || 'Sheet1!A:G');
      setTimezone(config.timezone || 'UTC');
    } catch (err) { setError(err.message); }
    finally { setLoading(false); }
  };

  useEffect(() => { refresh(); }, []);

  const connectGoogle = async () => {
    try {
      const data = await googleWorkspaceApi.connect();
      window.location.assign(data.authorizationUrl);
    } catch (err) { setError(err.message); }
  };

  const setAutomaticScheduling = async (enabled) => {
    setActionLoading(true); setError('');
    try {
      const data = await interviewSchedulingApi.setAutomation(enabled);
      setAutomation(current => ({ ...(current || {}), settings: data.settings }));
      setNotice(enabled ? 'Automatic scheduling enabled. SwiftCollab is processing eligible Sheet rows.' : 'Automatic scheduling disabled. No new Calendar events will be created.');
      setTimeout(refresh, 1200);
    } catch (err) { setError(err.message); }
    finally { setActionLoading(false); }
  };

  const saveGoogleSheet = async () => {
    setActionLoading(true); setError('');
    try {
      const data = await interviewSchedulingApi.saveConfiguration({
        source: 'google', spreadsheet_id: sheetLink, sheet_range: sheetRange, timezone,
        workday_start: configuration?.workday_start ?? 9,
        workday_end: configuration?.workday_end ?? 18,
        default_duration_minutes: configuration?.default_duration_minutes ?? 60,
        buffer_minutes: configuration?.buffer_minutes ?? 15,
        minimum_notice_hours: configuration?.minimum_notice_hours ?? 24,
        search_days: configuration?.search_days ?? 14,
      });
      setConfiguration(data.configuration);
      setNotice('Google Sheet saved. You can now enable automatic scheduling.');
    } catch (err) { setError(err.message); }
    finally { setActionLoading(false); }
  };

  const retryUnsuccessful = async () => {
    setActionLoading(true); setError('');
    try {
      const data = await interviewSchedulingApi.retryUnsuccessfulAutomation();
      setNotice(data.retried ? `${data.retried} failed or conflict record(s) returned to pending.` : 'There are no failed or conflict records to retry.');
      setTimeout(refresh, 1200);
    } catch (err) { setError(err.message); }
    finally { setActionLoading(false); }
  };

  const summary = automation?.summary || { pending: 0, processing: 0, scheduled: 0, rescheduled: 0, conflict: 0, failed: 0 };
  const enabled = Boolean(automation?.settings?.enabled);
  const sheetReady = configuration?.source === 'google' && Boolean(configuration?.spreadsheet_id);

  return (
    <div className="fixed inset-0 z-[70] bg-black/70 backdrop-blur-sm p-4 overflow-y-auto">
      <section className="max-w-3xl mx-auto my-8 bg-gray-900 border border-cyan-500/30 rounded-2xl p-6 text-white shadow-2xl">
        <div className="flex justify-between gap-4 mb-2"><div><h2 className="text-xl font-bold">Interview Scheduling</h2><p className="text-cyan-300 text-sm">Automatic scheduling is owner/admin controlled</p></div><button onClick={onClose} className="text-gray-300 hover:text-white">Close</button></div>
        {error && <div className="mb-4 p-3 rounded bg-red-900/30 text-red-200">{error}</div>}
        {notice && <div className="mb-4 p-3 rounded bg-cyan-500/10 border border-cyan-400/30 text-cyan-100" role="status">{notice}</div>}
        <div className={`p-3 mb-5 rounded-lg text-sm ${enabled ? 'bg-green-500/10 border border-green-400/30 text-green-100' : 'bg-amber-500/10 border border-amber-400/30 text-amber-200'}`}>
          {enabled ? 'Automatic scheduling is enabled. Valid ready rows can create Calendar events, Meet links, and Calendar invitations.' : 'Automatic scheduling is disabled. No Calendar event, Meet link, or invitation can be created.'}
        </div>
        <div className="border border-cyan-500/30 rounded-lg p-4">
          <div className="flex flex-wrap items-center justify-between gap-3"><div><h3 className="font-semibold">Automatic scheduling</h3><p className="text-sm text-gray-400">SwiftCollab processes valid “Ready to schedule” Sheet rows without individual scheduling buttons.</p></div><button onClick={refresh} disabled={loading || actionLoading} className="px-3 py-2 text-sm border border-gray-600 rounded hover:bg-gray-800 disabled:opacity-50">Refresh status</button></div>
          {googleStatus?.status !== 'connected' || googleStatus?.needs_reconnect ? <div className="mt-3 p-3 rounded bg-amber-500/10 text-amber-200"><p>Connect or reconnect Google Workspace to approve Calendar event creation permission.</p><button onClick={connectGoogle} className="mt-2 px-3 py-2 rounded bg-blue-600 text-white">{googleStatus?.status === 'connected' ? 'Reconnect Google Workspace' : 'Connect Google Workspace'}</button></div> : <div className="mt-4 space-y-3"><div className="grid sm:grid-cols-2 gap-3"><label className="text-sm text-gray-300">Google Sheet link<input value={sheetLink} onChange={event => setSheetLink(event.target.value)} placeholder="Paste Google Sheet link" className="mt-1 w-full bg-gray-800 border border-gray-600 rounded p-2 text-white" /></label><label className="text-sm text-gray-300">Sheet tab and range<input value={sheetRange} onChange={event => setSheetRange(event.target.value)} placeholder="Sheet1!A:G" className="mt-1 w-full bg-gray-800 border border-gray-600 rounded p-2 text-white" /></label></div><div className="flex flex-wrap items-end gap-3"><label className="text-sm text-gray-300">Sheet time zone for Preferred Start<input value={timezone} onChange={event => setTimezone(event.target.value)} placeholder="Asia/Kolkata" className="mt-1 w-full bg-gray-800 border border-gray-600 rounded p-2 text-white" /></label><button onClick={saveGoogleSheet} disabled={!sheetLink || actionLoading} className="px-3 py-2 rounded bg-blue-600 hover:bg-blue-500 disabled:bg-gray-700">Save Sheet</button></div><div className="flex flex-wrap items-center gap-3"><span className={`text-sm ${enabled ? 'text-green-300' : 'text-gray-300'}`}>{enabled ? 'Enabled' : sheetReady ? 'Sheet saved — ready to enable' : 'Save a Sheet before enabling'}</span><button onClick={() => setAutomaticScheduling(!enabled)} disabled={actionLoading || (!enabled && !sheetReady)} className={`px-3 py-2 rounded text-sm disabled:opacity-50 ${enabled ? 'bg-gray-700 hover:bg-gray-600' : 'bg-green-600 hover:bg-green-500'}`}>{enabled ? 'Disable automatic scheduling' : 'Enable automatic scheduling'}</button><button onClick={retryUnsuccessful} disabled={actionLoading} className="px-3 py-2 rounded text-sm border border-amber-400/50 text-amber-200 hover:bg-amber-500/10 disabled:opacity-50">Retry failed and conflict rows</button></div></div>}
          <div className="grid grid-cols-2 sm:grid-cols-6 gap-3 mt-4 text-sm"><div className="rounded bg-gray-800 p-3"><p className="text-gray-400">Pending</p><p className="text-xl font-semibold">{summary.pending}</p></div><div className="rounded bg-gray-800 p-3"><p className="text-gray-400">Processing</p><p className="text-xl font-semibold">{summary.processing}</p></div><div className="rounded bg-gray-800 p-3"><p className="text-gray-400">Scheduled</p><p className="text-xl font-semibold text-green-300">{summary.scheduled}</p></div><div className="rounded bg-gray-800 p-3"><p className="text-gray-400">Rescheduled</p><p className="text-xl font-semibold text-cyan-300">{summary.rescheduled}</p></div><div className="rounded bg-gray-800 p-3"><p className="text-gray-400">Conflicts</p><p className="text-xl font-semibold text-amber-300">{summary.conflict}</p></div><div className="rounded bg-gray-800 p-3"><p className="text-gray-400">Failed</p><p className="text-xl font-semibold text-red-300">{summary.failed}</p></div></div>
          <div className="mt-4 flex items-center justify-between gap-3"><h4 className="font-medium">Recent automatic results</h4><button onClick={() => { setHistoryHidden(true); setNotice('Displayed history cleared. Scheduling records and Calendar events were not changed.'); }} className="text-sm text-gray-300 underline hover:text-white">Clear displayed history</button></div>
          {!historyHidden && automation?.executions?.length > 0 && <div className="mt-2 space-y-2">{automation.executions.slice(0, 10).map(item => <div key={item.id} className="flex justify-between gap-3 text-sm border-t border-gray-800 pt-2"><span>{eventLabel(item)} <span className="text-gray-400">· {item.reschedule_count > 0 ? 'rescheduled' : item.status}</span></span><span className="text-right text-gray-400">{item.failure_reason || item.meeting_url || ''}</span></div>)}</div>}
          {!historyHidden && !loading && !automation?.executions?.length && <p className="mt-2 text-sm text-gray-400">No automatic scheduling records yet.</p>}
        </div>
      </section>
    </div>
  );
}
