import React, { useState, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import Sidebar from './components/Sidebar';
import DropZone from './components/DropZone';
import OrbitAnimation from './components/OrbitAnimation';
import ERPNextConnectModal from './components/ERPNextConnectModal';
import InterviewSchedulingPanel from './components/InterviewSchedulingPanel';
import OrganizationTeamPanel from './components/OrganizationTeamPanel';
import { Search, LogOut, User, Plus, Settings, Key, Link2 } from 'lucide-react';
import { AuthProvider, useAuth } from './contexts/AuthContext';
import LoginPage from './pages/LoginPage';
import { API_URL, assistantApi, api as apiClient, ApiError } from './services/api';

// Simple markdown renderer for chat messages
const renderMarkdown = (text) => {
  if (!text) return null;

  // Split by newlines first to handle line breaks
  const lines = text.split('\n');

  return lines.map((line, lineIdx) => {
    // Parse inline markdown: **bold**, *italic*, `code`
    const parts = [];
    let remaining = line;
    let partIdx = 0;

    while (remaining.length > 0) {
      // Check for **bold**
      const boldMatch = remaining.match(/\*\*(.+?)\*\*/);
      // Check for *italic*
      const italicMatch = remaining.match(/\*([^*]+)\*/);
      // Check for `code`
      const codeMatch = remaining.match(/`([^`]+)`/);

      // Find the earliest match
      const matches = [
        boldMatch ? { type: 'bold', match: boldMatch, index: remaining.indexOf(boldMatch[0]) } : null,
        italicMatch ? { type: 'italic', match: italicMatch, index: remaining.indexOf(italicMatch[0]) } : null,
        codeMatch ? { type: 'code', match: codeMatch, index: remaining.indexOf(codeMatch[0]) } : null,
      ].filter(Boolean).sort((a, b) => a.index - b.index);

      if (matches.length === 0) {
        // No more markdown, add remaining text
        if (remaining) parts.push(<span key={partIdx++}>{remaining}</span>);
        break;
      }

      const firstMatch = matches[0];

      // Add text before the match
      if (firstMatch.index > 0) {
        parts.push(<span key={partIdx++}>{remaining.substring(0, firstMatch.index)}</span>);
      }

      // Add the formatted text
      if (firstMatch.type === 'bold') {
        parts.push(<strong key={partIdx++} className="font-semibold">{firstMatch.match[1]}</strong>);
      } else if (firstMatch.type === 'italic') {
        parts.push(<em key={partIdx++}>{firstMatch.match[1]}</em>);
      } else if (firstMatch.type === 'code') {
        parts.push(<code key={partIdx++} className="bg-white/20 px-1 rounded text-xs">{firstMatch.match[1]}</code>);
      }

      // Continue with remaining text
      remaining = remaining.substring(firstMatch.index + firstMatch.match[0].length);
    }

    return (
      <React.Fragment key={lineIdx}>
        {parts}
        {lineIdx < lines.length - 1 && <br />}
      </React.Fragment>
    );
  });
};

// App Data - Only includes apps ACTUALLY available in Composio API (verified 2024)
// Left sidebar: CRM, Business, Communication, Design apps
const INITIAL_LEFT_APPS = [
  // CRM & Sales
  { id: 'salesforce', name: 'Salesforce', logo: '/logos/salesforce.png', type: 'crm' },
  { id: 'axonaut', name: 'Axonaut', logo: '/logos/axonaut.png', type: 'crm' },
  { id: 'hubspot', name: 'HubSpot', logo: '/logos/hubspot.png', type: 'crm' },
  { id: 'zendesk', name: 'Zendesk', logo: '/logos/zendesk.png', type: 'crm' },
  { id: 'intercom', name: 'Intercom', logo: '/logos/intercom.png', type: 'crm' },
  // Business & HR & ERP
  { id: 'servicenow', name: 'ServiceNow', logo: '/logos/servicenow.png', type: 'business' },
  { id: 'workday', name: 'Workday', logo: '/logos/workday.png', type: 'business' },
  { id: 'frappe', name: 'Frappe/ERPNext', logo: '/logos/frappe.png', type: 'business' },
  // Communication & Social
  { id: 'discord', name: 'Discord', logo: '/logos/discord.png', type: 'communication' },
  { id: 'twitter', name: 'Twitter/X', logo: '/logos/twitter.png', type: 'social' },
  { id: 'linkedin', name: 'LinkedIn', logo: '/logos/linkedin.png', type: 'social' },
  // Design & Collaboration
  { id: 'figma', name: 'Figma', logo: '/logos/figma.png', type: 'design' },
  { id: 'miro', name: 'Miro', logo: '/logos/miro.png', type: 'design' },
];

// Right sidebar: Productivity, Developer, Storage apps
const INITIAL_RIGHT_APPS = [
  // Core Productivity
  { id: 'gcalender', name: 'Google Calendar', logo: '/logos/google_calender.png', type: 'productivity' },
  { id: 'gmail', name: 'Gmail', logo: '/logos/gmail.png', type: 'productivity' },
  { id: 'slack', name: 'Slack', logo: '/logos/slack.png', type: 'productivity' },
  { id: 'zoom', name: 'Zoom', logo: '/logos/zoom.png', type: 'productivity' },
  { id: 'outlook', name: 'Outlook', logo: '/logos/outlook.png', type: 'productivity' },
  // Project Management
  { id: 'jira', name: 'Jira', logo: '/logos/jira.png', type: 'project' },
  { id: 'asana', name: 'Asana', logo: '/logos/asana.png', type: 'project' },
  { id: 'clickup', name: 'ClickUp', logo: '/logos/clickup.svg', type: 'project' },
  { id: 'notion', name: 'Notion', logo: '/logos/notion.png', type: 'project' },
  { id: 'trello', name: 'Trello', logo: '/logos/trello.png', type: 'project' },
  { id: 'monday', name: 'Monday.com', logo: '/logos/monday.png', type: 'project' },
  { id: 'todoist', name: 'Todoist', logo: '/logos/todoist.png', type: 'project' },
  // Developer Tools
  { id: 'github', name: 'GitHub', logo: '/logos/github.png', type: 'developer' },
  { id: 'gitlab', name: 'GitLab', logo: '/logos/gitlab.png', type: 'developer' },
  { id: 'bitbucket', name: 'Bitbucket', logo: '/logos/bitbucket.png', type: 'developer' },
  { id: 'confluence', name: 'Confluence', logo: '/logos/confluence.png', type: 'developer' },
  // Storage & Docs
  { id: 'drive', name: 'Google Drive', logo: '/logos/drive.png', type: 'storage' },
  { id: 'docs', name: 'Google Docs', logo: '/logos/docs.png', type: 'storage' },
  { id: 'sheets', name: 'Google Sheets', logo: '/logos/sheets.png', type: 'storage' },
  { id: 'dropbox', name: 'Dropbox', logo: '/logos/dropbox.png', type: 'storage' },
];

// Create a lookup map for app data by ID (for enriching workspace data)
const ALL_APPS = [...INITIAL_LEFT_APPS, ...INITIAL_RIGHT_APPS];
const APP_LOOKUP = ALL_APPS.reduce((acc, app) => {
  acc[app.id] = app;
  return acc;
}, {});

// Function to enrich apps with full data (logo, name, type) from lookup
const enrichAppsWithLogos = (apps) => {
  if (!Array.isArray(apps)) return [];
  return apps.map(app => {
    const fullApp = APP_LOOKUP[app.id];
    if (fullApp) {
      return { ...fullApp, ...app, logo: fullApp.logo };
    }
    // Fallback: if app has logo, use it; otherwise generate a path
    return {
      ...app,
      logo: app.logo || `/logos/${app.id}.png`,
    };
  });
};

// Fancy OS Component
const FancyOS = ({ className = "" }) => (
  <span
    className={`opacity-90 ${className}`}
    style={{
      fontFamily: '"Playfair Display", serif',
      fontStyle: 'italic',
      position: 'relative',
      top: '-0.5em',
      fontSize: '0.5em',
    }}
  >
    OS
  </span>
);

function App({ initialWorkspace, onWorkspaceChange }) {
  const { accessToken, logout } = useAuth();
  const [leftApps, setLeftApps] = useState(INITIAL_LEFT_APPS);
  const [rightApps, setRightApps] = useState(INITIAL_RIGHT_APPS);
  const [aiOsApps, setAiOsApps] = useState(() => enrichAppsWithLogos(initialWorkspace?.aiOsApps || []));
  const [workOsApps, setWorkOsApps] = useState(() => enrichAppsWithLogos(initialWorkspace?.workOsApps || []));
  const [phase, setPhase] = useState(initialWorkspace?.exists ? 'complete' : 'selection'); // 'selection', 'animating', 'complete'

  // Tooltip State
  const [tooltip, setTooltip] = useState({
    visible: false,
    text: '',
    x: 0,
    y: 0,
    side: 'left',
  });

  // ---- chat + backend state ----
  const [command, setCommand] = useState('');
  const [messages, setMessages] = useState([]); // { role: 'user' | 'assistant', text: string }[]
  const [followupContext, setFollowupContext] = useState(null);
  const [followupQuestions, setFollowupQuestions] = useState([]);
  const [answers, setAnswers] = useState({}); // { id: answer }
  const [lastCommand, setLastCommand] = useState('');
  const [appChoices, setAppChoices] = useState([]); // currently unused, but UI kept
  const [checkedTasks, setCheckedTasks] = useState({}); // { taskId: boolean } for brain recommendations
  const [isLoading, setIsLoading] = useState(false); // Loading state for async operations
  const [connectionStatus, setConnectionStatus] = useState({}); // { appId: { connected: boolean, authUrl?: string } }

  // ---- OAuth Config Modal State ----
  const [oauthConfigModal, setOauthConfigModal] = useState({
    visible: false,
    toolkit: '',
    fields: [],
    credentials: {},
    loading: false,
    error: null
  });

  // ---- Connection Params Modal State (for subdomain, etc.) ----
  const [connectionParamsModal, setConnectionParamsModal] = useState({
    visible: false,
    toolkit: '',
    fields: [],
    params: {},
    loading: false,
    error: null
  });

  // ---- API Key Modal State (for API_KEY auth apps like Axonaut) ----
  const [apiKeyModal, setApiKeyModal] = useState({
    visible: false,
    toolkit: '',
    appName: '',
    apiKey: '',
    apiSecret: '',
    requiresSecret: false,
    loading: false,
    error: null
  });

  // ---- Connect method chooser (Composio sign-in vs API key) ----
  const [connectMethodModal, setConnectMethodModal] = useState({
    visible: false,
    app: null,
    authUrl: null,
    loading: false,
    error: null
  });

  // ---- ERPNext Connect Modal State (for Frappe/ERPNext with URL + API Key + Secret) ----
  const [erpNextModalVisible, setErpNextModalVisible] = useState(false);

  const messagesEndRef = useRef(null);

  // Sync workspace to database when apps change during selection phase
  // This ensures that if user removes all apps and logs out, they see selection on next login
  useEffect(() => {
    if (phase !== 'selection') return;

    const syncWorkspace = async () => {
      const hasApps = aiOsApps.length > 0 || workOsApps.length > 0;

      if (!hasApps) {
        // Delete workspace when all apps are removed
        try {
          await fetch(`${API_URL}/api/workspace`, {
            method: 'DELETE',
            headers: { 'Authorization': `Bearer ${accessToken}` },
          });
          console.log('[Workspace] Deleted (no apps)');
        } catch (err) {
          console.error('[Workspace] Delete error:', err);
        }
      }
    };

    // Debounce to avoid too many requests
    const timeoutId = setTimeout(syncWorkspace, 500);
    return () => clearTimeout(timeoutId);
  }, [aiOsApps, workOsApps, phase, accessToken]);

  // Keep ApiService in sync with auth token
  useEffect(() => {
    apiClient.setAccessToken(accessToken || null);
  }, [accessToken]);

  // Auto-scroll chat to bottom when messages change
  useEffect(() => {
    if (messagesEndRef.current) {
      messagesEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [messages]);

  // Selected app IDs (both AI OS and Work OS)
  const selectedAppIds = [...aiOsApps, ...workOsApps].map(app => app.id);

  const handleDragStart = (e, app) => {
    e.dataTransfer.setData('appId', app.id);
    // Left sidebar types: crm, business, payments, ecommerce, marketing
    // Right sidebar types: productivity
    const leftTypes = ['crm', 'business', 'payments', 'ecommerce', 'marketing'];
    e.dataTransfer.setData(
      'source',
      leftTypes.includes(app.type) ? 'left' : 'right'
    );
    e.dataTransfer.setData('appData', JSON.stringify(app));
    // Hide tooltip on drag
    setTooltip({ ...tooltip, visible: false });
  };

  const handleDrop = (e, targetZone) => {
    e.preventDefault();
    const appData = JSON.parse(e.dataTransfer.getData('appData'));
    const source = e.dataTransfer.getData('source');

    if (targetZone === 'ai' && source === 'left') {
      if (!aiOsApps.find(a => a.id === appData.id)) {
        setAiOsApps([...aiOsApps, appData]);
      }
    } else if (targetZone === 'work' && source === 'right') {
      if (!workOsApps.find(a => a.id === appData.id)) {
        setWorkOsApps([...workOsApps, appData]);
      }
    }
  };

  // Remove app from AI OS drop zone
  const handleRemoveFromAiOs = (appId) => {
    setAiOsApps(aiOsApps.filter(app => app.id !== appId));
  };

  // Remove app from Work OS drop zone
  const handleRemoveFromWorkOs = (appId) => {
    setWorkOsApps(workOsApps.filter(app => app.id !== appId));
  };

  const handleCreateOS = async () => {
    if (aiOsApps.length > 0 || workOsApps.length > 0) {
      setPhase('animating');

      // Save workspace to backend (don't await - let animation play)
      fetch(`${API_URL}/api/workspace`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${accessToken}`,
        },
        body: JSON.stringify({
          aiOsApps,
          workOsApps,
        }),
      })
        .then(() => console.log('[Workspace] Saved successfully'))
        .catch((err) => console.error('[Workspace] Save error:', err));

      // Show animation for 4 seconds, then transition to complete
      setTimeout(() => {
        setPhase('complete');
        // Notify parent after animation completes (don't reload - we already have the data)
      }, 4000);
    }
  };

  // Handle going back to selection (Add Apps)
  const handleEditApps = async () => {
    setPhase('selection');
  };

  const handleAppHover = (app, rect, side) => {
    setTooltip({
      visible: true,
      text: app.name,
      x: side === 'left' ? rect.right + 10 : rect.left - 10,
      y: rect.top + rect.height / 2,
      side: side,
    });
  };

  const handleAppLeave = () => {
    setTooltip({ ...tooltip, visible: false });
  };

  // ---- Check connection status for apps ----
  const checkAppConnections = async (appIds) => {
    if (!appIds || appIds.length === 0) return;

    try {
      const headers = { 'Content-Type': 'application/json' };
      if (accessToken) {
        headers['Authorization'] = `Bearer ${accessToken}`;
      }

      const response = await fetch(`${API_URL}/api/connection-status`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ appIds }),
      });

      const data = await response.json();
      console.log('[Connection] Status check:', data);

      if (data.connections) {
        setConnectionStatus(prev => ({ ...prev, ...data.connections }));
      }
      return data.connections || {};
    } catch (err) {
      console.error('[Connection] Check error:', err);
      return {};
    }
  };

  const CUSTOM_CONNECT_APPS = ['frappe', 'erpnext'];

  // ---- Handle app Connect button click ----
  const onAppConnect = (app, authUrl) => {
    if (CUSTOM_CONNECT_APPS.includes(app.id?.toLowerCase())) {
      showApiKeyModal(app.id.toUpperCase(), app.name);
      return;
    }

    setConnectMethodModal({
      visible: true,
      app,
      authUrl: authUrl || null,
      loading: false,
      error: null
    });
  };

  const watchComposioPopup = (app, popup) => {
    const checkInterval = setInterval(async () => {
      try {
        const connections = await checkAppConnections([app.id]);
        if (connections[app.id]?.connected) {
          clearInterval(checkInterval);
          if (popup && !popup.closed) {
            popup.close();
          }
          setMessages(prev => [...prev, {
            role: 'assistant',
            text: `✅ Successfully connected to ${app.name}! You can now use it.`
          }]);
        }
      } catch (err) {
        // Ignore polling errors
      }
    }, 3000);

    setTimeout(() => clearInterval(checkInterval), 120000);
  };

  const startComposioConnect = async (app, authUrl) => {
    if (authUrl) {
      console.log('[OAuth] Opening Composio auth URL for', app.name);
      const popup = window.open(authUrl, '_blank', 'width=600,height=700');
      watchComposioPopup(app, popup);
      return;
    }

    await handleConnectApp(app.id);
  };

  // ---- Check connections when apps change ----
  useEffect(() => {
    const allApps = [...aiOsApps, ...workOsApps];
    const appIds = allApps.map(app => app.id);
    if (appIds.length > 0) {
      checkAppConnections(appIds);
    }
  }, [aiOsApps, workOsApps]);

  // ---- Connect app via OAuth ----
  const handleConnectApp = async (toolkit, connectionParams = {}) => {
    try {
      const displayName = toolkit.replace('GOOGLE', 'Google ');

      setMessages(prev => [
        ...prev,
        { role: 'assistant', text: `Connecting ${displayName}... Opening authorization window.` }
      ]);

      // Build headers - include auth token for per-user account isolation
      const headers = { 'Content-Type': 'application/json' };
      if (accessToken) {
        headers['Authorization'] = `Bearer ${accessToken}`;
      }

      // Call backend to initiate OAuth
      const response = await fetch(`${API_URL}/api/connections/initiate`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          appId: toolkit, // Send toolkit name directly
          redirectUrl: `${API_URL}/api/connections/callback`,
          connectionParams  // Pass additional params like subdomain
        })
      });

      const data = await response.json();
      console.log('[OAuth] Initiate response:', data);

      if (data.redirectUrl) {
        // Open Composio Connect Link / OAuth in a popup
        const popup = window.open(data.redirectUrl, '_blank', 'width=600,height=700');

        // If we have a connection ID, poll for its status
        if (data.connectionId) {
          setMessages(prev => [
            ...prev,
            { role: 'assistant', text: `Please complete the authorization in the popup window. Waiting for connection...` }
          ]);

          // Poll for connection status
          const pollInterval = setInterval(async () => {
            try {
              const checkResponse = await fetch(`${API_URL}/api/connections/check/${data.connectionId}`);
              const checkData = await checkResponse.json();
              console.log('[OAuth] Connection status:', checkData);

              if (checkData.isActive) {
                clearInterval(pollInterval);
                setMessages(prev => [
                  ...prev,
                  {
                    role: 'assistant',
                    text: `✅ Successfully connected to ${displayName}! You can now try your request again.`
                  }
                ]);
                // Close the popup if still open
                if (popup && !popup.closed) {
                  popup.close();
                }
              }
            } catch (pollErr) {
              console.log('[OAuth] Poll error (may be normal):', pollErr);
            }
          }, 2000); // Poll every 2 seconds

          // Stop polling after 2 minutes
          setTimeout(() => {
            clearInterval(pollInterval);
          }, 120000);
        } else {
          setMessages(prev => [
            ...prev,
            { role: 'assistant', text: `Please complete the authorization in the popup window. Once done, try your request again.` }
          ]);
        }
      } else if (data.error) {
        if (data.error.includes('Missing required fields')) {
          await showConnectionParamsModal(toolkit);
          return;
        }
        throw new Error(data.error);
      } else {
        throw new Error('Composio did not return a sign-in URL. Enable this app in your Composio dashboard, then try Sign in with Composio again.');
      }
    } catch (err) {
      console.error('Connect error:', err);
      if (err.message?.includes('Missing required fields')) {
        await showConnectionParamsModal(toolkit);
        return;
      }
      setMessages(prev => [
        ...prev,
        { role: 'assistant', text: `Failed to connect via Composio: ${err.message}` }
      ]);
      throw err;
    }
  };

  // Show OAuth config modal for apps that need custom setup
  const showOAuthConfigModal = async (toolkit) => {
    try {
      setMessages(prev => [
        ...prev,
        { role: 'assistant', text: `${toolkit} requires OAuth setup. Loading configuration form...` }
      ]);

      // Fetch the required fields from backend
      const response = await fetch(`${API_URL}/api/auth-config/fields/${toolkit}`);
      const data = await response.json();

      if (data.fields) {
        setOauthConfigModal({
          visible: true,
          toolkit: toolkit,
          fields: data.fields,
          redirectUri: data.redirectUri,
          credentials: {},
          loading: false,
          error: null
        });
      } else {
        setMessages(prev => [
          ...prev,
          { role: 'assistant', text: `Error: Could not load OAuth fields for ${toolkit}` }
        ]);
      }
    } catch (err) {
      console.error('Error loading OAuth fields:', err);
      setMessages(prev => [
        ...prev,
        { role: 'assistant', text: `Error loading OAuth configuration: ${err.message}` }
      ]);
    }
  };

  // Handle OAuth config form submission
  const handleOAuthConfigSubmit = async () => {
    try {
      setOauthConfigModal(prev => ({ ...prev, loading: true, error: null }));

      const response = await fetch(`${API_URL}/api/auth-config/create`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          toolkit: oauthConfigModal.toolkit,
          credentials: oauthConfigModal.credentials,
          name: `${oauthConfigModal.toolkit} Auth Config`
        })
      });

      const data = await response.json();

      if (data.success) {
        setOauthConfigModal({ visible: false, toolkit: '', fields: [], credentials: {}, loading: false, error: null });
        setMessages(prev => [
          ...prev,
          { role: 'assistant', text: `✅ OAuth configuration saved for ${oauthConfigModal.toolkit}! Now connecting...` }
        ]);
        // Now try to connect again
        await handleConnectApp(oauthConfigModal.toolkit);
      } else {
        setOauthConfigModal(prev => ({ ...prev, loading: false, error: data.error }));
      }
    } catch (err) {
      setOauthConfigModal(prev => ({ ...prev, loading: false, error: err.message }));
    }
  };

  // Show connection params modal for apps that need additional fields (like subdomain)
  const showConnectionParamsModal = async (toolkit) => {
    try {
      setMessages(prev => [
        ...prev,
        { role: 'assistant', text: `${toolkit} requires additional information to connect. Loading form...` }
      ]);

      // Fetch the required connection fields from backend
      const response = await fetch(`${API_URL}/api/connections/fields/${toolkit}`);
      const data = await response.json();

      if (data.fields && data.fields.length > 0) {
        setConnectionParamsModal({
          visible: true,
          toolkit: toolkit,
          fields: data.fields,
          params: {},
          loading: false,
          error: null
        });
      } else {
        setMessages(prev => [
          ...prev,
          { role: 'assistant', text: `Error: Could not load connection fields for ${toolkit}` }
        ]);
      }
    } catch (err) {
      console.error('Error loading connection fields:', err);
      setMessages(prev => [
        ...prev,
        { role: 'assistant', text: `Error loading connection fields: ${err.message}` }
      ]);
    }
  };

  // Handle connection params form submission
  const handleConnectionParamsSubmit = async () => {
    try {
      setConnectionParamsModal(prev => ({ ...prev, loading: true, error: null }));

      // Close modal and try to connect with the params
      const toolkit = connectionParamsModal.toolkit;
      const params = connectionParamsModal.params;

      setConnectionParamsModal({ visible: false, toolkit: '', fields: [], params: {}, loading: false, error: null });

      // Now connect with the params
      await handleConnectApp(toolkit, params);
    } catch (err) {
      setConnectionParamsModal(prev => ({ ...prev, loading: false, error: err.message }));
    }
  };

  // Apps that use the dedicated ERPNext connection modal (with URL + API Key + Secret)
  const ERPNEXT_APPS = ['FRAPPE', 'ERPNEXT'];

  // Show API Key modal for apps that use API_KEY authentication (like Axonaut)
  const showApiKeyModal = (toolkit, appName) => {
    // For Frappe/ERPNext, use the dedicated modal with URL field
    if (ERPNEXT_APPS.includes(toolkit.toUpperCase())) {
      setErpNextModalVisible(true);
      return;
    }

    setApiKeyModal({
      visible: true,
      toolkit: toolkit,
      appName: appName || toolkit,
      apiKey: '',
      apiSecret: '',
      requiresSecret: false,
      loading: false,
      error: null
    });
  };

  // Handle successful ERPNext connection
  const handleErpNextConnectSuccess = (connectionData) => {
    setMessages(prev => [
      ...prev,
      {
        role: 'assistant',
        text: `Connected to ERPNext as **${connectionData.erpUser}**${connectionData.erpCompany ? ` (${connectionData.erpCompany})` : ''}! You can now use Frappe/ERPNext in your workflows.`
      }
    ]);

    // Update connection status
    setConnectionStatus(prev => ({
      ...prev,
      frappe: { connected: true }
    }));
  };

  // Handle API Key form submission
  const handleApiKeySubmit = async () => {
    try {
      setApiKeyModal(prev => ({ ...prev, loading: true, error: null }));

      const { toolkit, apiKey, apiSecret, requiresSecret } = apiKeyModal;

      if (!apiKey.trim()) {
        setApiKeyModal(prev => ({ ...prev, loading: false, error: 'API key is required' }));
        return;
      }

      if (requiresSecret && !apiSecret.trim()) {
        setApiKeyModal(prev => ({ ...prev, loading: false, error: 'API secret is required' }));
        return;
      }

      // Build credentials object
      const credentials = { api_key: apiKey };
      if (requiresSecret && apiSecret.trim()) {
        credentials.api_secret = apiSecret;
      }

      // Create auth config with the API key (and secret if required)
      const response = await fetch(`${API_URL}/api/auth-config/create`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          toolkit: toolkit,
          credentials: credentials,
          name: `${toolkit} Auth Config`
        })
      });

      const data = await response.json();

      if (data.success) {
        setApiKeyModal({ visible: false, toolkit: '', appName: '', apiKey: '', apiSecret: '', requiresSecret: false, loading: false, error: null });
        setMessages(prev => [
          ...prev,
          { role: 'assistant', text: `✅ Credentials saved for ${apiKeyModal.appName}! Now connecting...` }
        ]);

        // Now try to connect using the saved API key credentials
        await handleConnectApp(toolkit).catch(() => {});

        // Refresh connection status
        const allApps = [...aiOsApps, ...workOsApps];
        const appIds = allApps.map(app => app.id);
        if (appIds.length > 0) {
          await checkAppConnections(appIds);
        }
      } else {
        setApiKeyModal(prev => ({ ...prev, loading: false, error: data.error || 'Failed to save API key' }));
      }
    } catch (err) {
      console.error('API key submit error:', err);
      setApiKeyModal(prev => ({ ...prev, loading: false, error: err.message }));
    }
  };

  // Send a request to the assistant API with auth + selected apps + recent history
  const sendAssistantRequest = async (payload) => {
    const baseBody = {
      selectedApps: selectedAppIds,
      conversationHistory: messages.slice(-10),
      ...payload,
    };

    try {
      return await assistantApi.sendMessage(baseBody);
    } catch (err) {
      if (err instanceof ApiError) {
        throw err;
      }
      throw new ApiError(err.message || 'Request failed', 0);
    }
  };

  // ---- Daily Planner handler ----
  const handleDailyPlanner = async () => {
    if (!accessToken) {
      setMessages(prev => [...prev, {
        role: 'assistant',
        text: 'Please log in to use the Daily Planner feature.',
      }]);
      return;
    }

    setMessages(prev => [...prev, {
      role: 'user',
      text: '📅 Generate my daily plan',
    }]);
    setIsLoading(true);

    try {
      const response = await fetch(`${API_URL}/api/daily-planner`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${accessToken}`,
        },
        body: JSON.stringify({ forceRefresh: true }),
      });

      const data = await response.json();

      if (data.success && data.plan) {
        const plan = data.plan;
        let planMessage = '📋 **Your Daily Plan**\n\n';

        if (plan.summary) {
          planMessage += `${plan.summary}\n\n`;
        }

        if (plan.priorities && plan.priorities.length > 0) {
          planMessage += '**🎯 Top Priorities:**\n';
          plan.priorities.forEach((p, i) => {
            planMessage += `${i + 1}. ${p.title || p}\n`;
          });
          planMessage += '\n';
        }

        if (plan.meetings && plan.meetings.length > 0) {
          planMessage += '**📆 Upcoming Meetings:**\n';
          plan.meetings.forEach(m => {
            planMessage += `• ${m.time || ''} - ${m.title || m.summary}\n`;
          });
          planMessage += '\n';
        }

        if (plan.tasks && plan.tasks.length > 0) {
          planMessage += '**✅ Tasks:**\n';
          plan.tasks.forEach(t => {
            planMessage += `• ${t.title || t}\n`;
          });
          planMessage += '\n';
        }

        if (plan.recommendations && plan.recommendations.length > 0) {
          planMessage += '**💡 Recommendations:**\n';
          plan.recommendations.forEach(r => {
            planMessage += `• ${r}\n`;
          });
        }

        setMessages(prev => [...prev, {
          role: 'assistant',
          text: planMessage || 'Your daily plan has been generated!',
        }]);
      } else {
        setMessages(prev => [...prev, {
          role: 'assistant',
          text: data.error || 'Could not generate daily plan. Please try again.',
        }]);
      }
    } catch (err) {
      console.error('[DailyPlanner] Error:', err);
      setMessages(prev => [...prev, {
        role: 'assistant',
        text: `Error generating daily plan: ${err.message}`,
      }]);
    } finally {
      setIsLoading(false);
    }
  };

  // ---- NEW: unified multi-app command handler (calls /api/ai/assistant) ----
  const handleRunCommand = async (isFollowup = false) => {
    let currentText = command.trim();

    // DEBUG: Comprehensive logging
    console.log('[App] ========================================');
    console.log('[App] handleRunCommand called');
    console.log('[App] isFollowup param:', isFollowup);
    console.log('[App] currentText:', `"${currentText}"`);
    console.log('[App] followupContext:', JSON.stringify(followupContext, null, 2));
    console.log('[App] followupContext type:', typeof followupContext);
    console.log('[App] pendingFields exists:', followupContext?.pendingFields);
    console.log('[App] pendingFields length:', followupContext?.pendingFields?.length);
    console.log('[App] ========================================');

    // No apps have been dragged in at all
    if (selectedAppIds.length === 0) {
      setMessages(prev => [
        ...prev,
        {
          role: 'assistant',
          text: 'Drag at least one app into AI OS or Work OS before running commands.',
        },
      ]);
      return;
    }

    // CRITICAL: Check for natural language followup response FIRST
    // This handles when user types a response like "kan" or "project = KAN" after being asked for JQL
    // Check all three conditions separately for debugging
    const hasContext = !!followupContext;
    const hasPendingFieldsArray = !!(followupContext && followupContext.pendingFields);
    const hasPendingFieldsLength = !!(followupContext && followupContext.pendingFields && followupContext.pendingFields.length > 0);
    const hasPendingFollowup = hasContext && hasPendingFieldsArray && hasPendingFieldsLength;

    console.log('[App] FOLLOWUP CHECK: hasContext=', hasContext, 'hasPendingFieldsArray=', hasPendingFieldsArray, 'hasPendingFieldsLength=', hasPendingFieldsLength, 'FINAL=', hasPendingFollowup);

    if (isFollowup) {
      // Follow-up: reuse lastCommand as the "intent", but allow user to add clarifications
      if (!currentText) {
        currentText = lastCommand || '(continuing previous request)';
      }
    } else {
      if (!currentText) return;

      // CHECK: If there's pending followup context, send user's message as natural language response
      // The backend will extract the answers from the user's natural language
      if (hasPendingFollowup) {
        console.log('[App] FOLLOWUP DETECTED: User responding to followup questions naturally');
        console.log('[App] followupContext:', JSON.stringify(followupContext));
        console.log('[App] currentText:', currentText);

        setMessages(prev => [...prev, { role: 'user', text: currentText }]);
        setCommand('');

        try {
          const data = await sendAssistantRequest({
            message: currentText,
            followupContext,
          });

          console.log('[App] Response data:', JSON.stringify(data));

          if (data.type === 'followup' || data.type === 'needs_info') {
            // Still needs more info
            const ctx = data.followupContext || null;
            if (data.conversationId && ctx) {
              ctx.conversationId = data.conversationId;
            }
            setFollowupContext(ctx);
            setMessages(prev => [
              ...prev,
              { role: 'assistant', text: data.message || 'I need a few more details.' },
            ]);
          } else if (data.type === 'confirmation_required') {
            // Execution confirmation needed
            const ctx = data.followupContext || null;
            if (data.conversationId && ctx) {
              ctx.conversationId = data.conversationId;
            }
            setFollowupContext(ctx);
            setMessages(prev => [
              ...prev,
              { role: 'assistant', text: data.message || 'Should I proceed? (yes/no)' },
            ]);
          } else if (data.type === 'completed' || data.type === 'success' || data.type === 'partial_success') {
            // Task completed!
            setFollowupContext(null);
            setMessages(prev => [...prev, { role: 'assistant', text: data.message }]);
          } else if (data.type === 'cancelled') {
            // User declined
            setFollowupContext(null);
            setMessages(prev => [...prev, { role: 'assistant', text: data.message || 'Okay, cancelled.' }]);
          } else {
            // Other response types
            setFollowupContext(null);
            const assistantText = data.message || data.response || JSON.stringify(data, null, 2);
            setMessages(prev => [...prev, { role: 'assistant', text: assistantText }]);
          }
        } catch (err) {
          console.error('[App] Followup fetch error:', err);
          setMessages(prev => [...prev, { role: 'assistant', text: `Error: ${err.message}` }]);
        }
        return;
      }

      // Clear any pending follow-up state when starting a NEW query
      setFollowupQuestions([]);
      setFollowupContext(null);
      setAnswers({});

      setMessages(prev => [...prev, { role: 'user', text: currentText }]);
      setLastCommand(currentText);
      setCommand('');
    }

    try {
      // Only send follow-up context if this IS a follow-up request
      const requestBody = {
        message: currentText,
      };

      // Only include follow-up data if this is actually a follow-up
      if (isFollowup && followupContext) {
        requestBody.followupContext = followupContext;
        requestBody.answers = Object.entries(answers).map(([id, answer]) => ({
          id,
          answer,
        }));
      }

      const data = await sendAssistantRequest(requestBody);

      // Handle follow-up questions from Composio (backend sends 'needs_info' or 'followup')
      if (data.type === 'followup' || data.type === 'needs_info') {
        console.log('[App] FOLLOWUP RESPONSE - storing context:', JSON.stringify(data.followupContext));
        setFollowupQuestions(data.followupQuestions || []);
        // CRITICAL: Store the followupContext properly - never set to empty object
        let newContext = data.followupContext && data.followupContext.pendingFields ? data.followupContext : null;
        if (data.conversationId && newContext) {
          newContext = { ...newContext, conversationId: data.conversationId };
        }
        console.log('[App] Setting followupContext to:', JSON.stringify(newContext));
        setFollowupContext(newContext);
        setAnswers({}); // Clear previous answers when new questions arrive
        setMessages(prev => [
          ...prev,
          {
            role: 'assistant',
            text: data.message || 'I need a few more details to complete this.',
          },
        ]);
        return;
      }

      // Handle confirmation required (yes/no prompts for execution)
      if (data.type === 'confirmation_required') {
        console.log('[App] CONFIRMATION REQUIRED - storing context:', JSON.stringify(data.followupContext));
        // Store the followupContext so next message (yes/no) includes sessionId
        let newContext = data.followupContext || null;
        if (data.conversationId && newContext) {
          newContext = { ...newContext, conversationId: data.conversationId };
        }
        console.log('[App] Setting followupContext for confirmation:', JSON.stringify(newContext));
        setFollowupContext(newContext);
        setMessages(prev => [
          ...prev,
          {
            role: 'assistant',
            text: data.message || 'Should I proceed? (yes/no)',
          },
        ]);
        return;
      }

      // Handle "app not available" - user requested app not in workspace
      if (data.type === 'app_not_available') {
        setFollowupQuestions([]);
        setFollowupContext(null);
        setAnswers({});

        let text = data.message || "I can't complete this request with your current apps.";

        if (data.missingApps && data.missingApps.length > 0) {
          text += `\n\nMissing apps: ${data.missingApps.join(', ')}`;
        }

        setMessages(prev => [...prev, { role: 'assistant', text }]);
        return;
      }

      // Handle login required - token expired or user not authenticated
      if (data.type === 'login_required') {
        setMessages(prev => [
          ...prev,
          {
            role: 'assistant',
            text: data.message || 'Please log in to continue.',
            loginRequired: true,
          },
        ]);
        return;
      }

      // Handle authentication required - show connect buttons
      if (data.type === 'auth_required') {
        const toolkits = data.toolkits || [];
        setMessages(prev => [
          ...prev,
          {
            role: 'assistant',
            text: data.message || 'You need to connect your accounts first.',
            authRequired: true,
            toolkits: toolkits,
          },
        ]);
        return;
      }

      // Handle OAuth required with direct URL - for user account isolation
      if (data.type === 'oauth_required') {
        setMessages(prev => [
          ...prev,
          {
            role: 'assistant',
            text: data.message || 'Please connect your account to continue.',
            oauthRequired: true,
            oauthUrl: data.oauthUrl,
            connectionId: data.connectionId,
            toolkit: data.toolkit,
            app: data.app,
          },
        ]);
        return;
      }

      // Handle brain recommendations - "what to do today" response
      if (data.type === 'brain_recommendations') {
        setFollowupQuestions([]);
        setFollowupContext(null);
        setAnswers({});

        setMessages(prev => [
          ...prev,
          {
            role: 'assistant',
            text: data.greeting || "Here's your day at a glance:",
            brainRecommendations: true,
            summary: data.summary,
            tasks: data.tasks || [],
            summaryData: data.summaryData,
          },
        ]);
        return;
      }

      // Handle guidance/how-to responses
      if (data.type === 'guidance') {
        setFollowupQuestions([]);
        setFollowupContext(null);
        setAnswers({});

        setMessages(prev => [
          ...prev,
          {
            role: 'assistant',
            text: data.message || "Here's your guidance:",
            guidance: true,
            title: data.title,
            appName: data.appName,
            steps: data.steps || [],
            tips: data.tips || [],
            docLink: data.docLink,
            canAutomate: data.canAutomate,
            raw: data.raw,
          },
        ]);
        return;
      }

      // Handle successful completion (Composio)
      if (data.type === 'completed' || data.type === 'success' || data.type === 'partial_success' || data.type === 'partial' || data.type === 'failed') {
        setFollowupQuestions([]);
        setFollowupContext(null);
        setAnswers({});

        let text = data.message || 'Request processed.';

        // Show execution results if available
        if (Array.isArray(data.results) && data.results.length > 0) {
          const hasErrors = data.results.some(r => !r.success);
          if (hasErrors) {
            const errors = data.results.filter(r => !r.success);
            text += `\n\n⚠️ Some actions had issues:\n${errors.map(e => `- ${e.tool}: ${e.error}`).join('\n')}`;
          }
        }

        setMessages(prev => [...prev, { role: 'assistant', text }]);
        return;
      }

      // Handle casual conversation responses
      if (data.type === 'casual') {
        setMessages(prev => [
          ...prev,
          {
            role: 'assistant',
            text: data.message || "Hey there! How can I help you today?",
          },
        ]);
        return;
      }

      // Handle cancelled (user said no to confirmation)
      if (data.type === 'cancelled') {
        setFollowupQuestions([]);
        setFollowupContext(null);
        setAnswers({});
        setMessages(prev => [
          ...prev,
          {
            role: 'assistant',
            text: data.message || 'Okay, cancelled.',
          },
        ]);
        return;
      }

      // Handle error responses
      if (data.type === 'error' || data.type === 'no_action' || data.type === 'no_tools') {
        setMessages(prev => [
          ...prev,
          {
            role: 'assistant',
            text: data.message || 'Something went wrong. Please try again.',
          },
        ]);
        return;
      }

      // Legacy: Multi-app success (keeping for backwards compatibility)
      if (data.type === 'multi_done') {
        setFollowupQuestions([]);
        setFollowupContext(null);
        setAnswers({});

        let text =
          data.message ||
          'Finished running the requested actions across your connected apps.';

        if (data.summary) {
          text += `\n\nSummary:\n${data.summary}`;
        }

        if (Array.isArray(data.executionResults) && data.executionResults.length > 0) {
          const lines = data.executionResults.map((r) => {
            const label = `${r.kind || 'TASK'} in ${r.appId || 'app'}`;
            const status = r.status || 'done';

            if (r.summaryText) {
              return `- ${label}: ${status}. Summary: ${r.summaryText}`;
            }
            if (status === 'error' && r.error) {
              return `- ${label}: error – ${r.error}`;
            }
            return `- ${label}: ${status}`;
          });
          text += `\n\nDetails:\n${lines.join('\n')}`;
        }

        setMessages(prev => [...prev, { role: 'assistant', text }]);
        return;
      }

      // Fallback: show whatever we got
      const assistantText = data.message || JSON.stringify(data, null, 2);
      setMessages(prev => [...prev, { role: 'assistant', text: assistantText }]);
    } catch (err) {
      console.error(err);
      setMessages(prev => [
        ...prev,
        {
          role: 'assistant',
          text: 'Something went wrong talking to the backend (assistant).',
        },
      ]);
    }
  };

  const handleCommandKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleRunCommand(false);
    }
  };

  const handleAnswerChange = (id, value) => {
    setAnswers(prev => ({ ...prev, [id]: value }));
  };

  const handleSubmitFollowups = async () => {
    await handleRunCommand(true);
  };

  return (
    <div className="relative w-full h-screen bg-black text-white overflow-hidden flex flex-col">
      {/* Background Elements */}
      <div className="absolute top-0 left-0 w-full h-full overflow-hidden z-0 pointer-events-none">
        <div className="absolute top-[-10%] left-[-10%] w-[40%] h-[40%] bg-white/5 rounded-full blur-[120px]" />
        <div className="absolute bottom-[-10%] right-[-10%] w-[40%] h-[40%] bg-white/5 rounded-full blur-[120px]" />
      </div>

      <div className="relative z-10 w-full h-full flex flex-col">
        {/* Header */}
        <header className="w-full p-6 flex justify-center items-center border-b border-white/5 backdrop-blur-sm">
          <div className="flex items-center leading-none select-none">
            <span
              className="text-4xl font-bold text-white tracking-tight"
              style={{ fontFamily: '"Outfit", sans-serif' }}
            >
              SwiftCollab
            </span>
            <FancyOS className="text-3xl ml-1" />
          </div>
        </header>

        {/* Main Content */}
        <AnimatePresence mode="wait">
          {phase === 'selection' && (
            <motion.div
              key="selection"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0, scale: 0.9 }}
              className="flex-1 flex overflow-hidden"
            >
              {/* Left Sidebar */}
              <Sidebar
                title="SaaS Platforms"
                apps={leftApps}
                side="left"
                onDragStart={handleDragStart}
                onAppHover={handleAppHover}
                onAppLeave={handleAppLeave}
              />

              {/* Center Stage */}
              <div className="flex-1 flex flex-col items-center justify-center p-8 gap-8 relative">
                <div className="flex w-full max-w-5xl gap-8 h-[60vh]">
                  <DropZone
                    title={
                      <>
                        AI <FancyOS className="text-lg" />
                      </>
                    }
                    apps={aiOsApps}
                    onDrop={(e) => handleDrop(e, 'ai')}
                    onRemove={handleRemoveFromAiOs}
                    connectionStatus={connectionStatus}
                    onConnect={onAppConnect}
                    color="white"
                  />
                  <DropZone
                    title={
                      <>
                        Work <FancyOS className="text-lg" />
                      </>
                    }
                    apps={workOsApps}
                    onDrop={(e) => handleDrop(e, 'work')}
                    onRemove={handleRemoveFromWorkOs}
                    connectionStatus={connectionStatus}
                    onConnect={onAppConnect}
                    color="white"
                  />
                </div>

                <motion.button
                  whileHover={{ scale: 1.05 }}
                  whileTap={{ scale: 0.95 }}
                  onClick={handleCreateOS}
                  className="px-10 py-4 bg-white/20 backdrop-blur-md border border-white/30 hover:bg-white/25 rounded-full text-lg font-bold shadow-lg shadow-white/10 transition-all text-white flex items-center gap-2"
                >
                  Create SwiftCollab{' '}
                  <span className="blink">
                    <FancyOS className="text-lg text-white" />
                  </span>
                </motion.button>
              </div>

              {/* Right Sidebar */}
              <Sidebar
                title="Productivity Apps"
                apps={rightApps}
                side="right"
                onDragStart={handleDragStart}
                showAddButton
                onAppHover={handleAppHover}
                onAppLeave={handleAppLeave}
              />
            </motion.div>
          )}

          {phase === 'animating' && (
            <motion.div
              key="animating"
              initial={{ opacity: 0, scale: 0.8 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 1.1 }}
              transition={{ duration: 0.5 }}
              className="flex-1 flex items-center justify-center"
            >
              <OrbitAnimation
                aiApps={aiOsApps}
                workApps={workOsApps}
              />
            </motion.div>
          )}

          {phase === 'complete' && (
            <motion.div
              key="complete"
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.8 }}
              className="flex-1 w-full overflow-y-auto"
            >
              <div className="min-h-full flex flex-col items-center justify-center py-8">
                <div className="w-full max-w-2xl">
                  <div className="flex items-center justify-between mb-8">
                    <h2
                      className="text-2xl font-bold text-white/70"
                      style={{ fontFamily: '"Outfit", sans-serif' }}
                    >
                      Your Industry Platform is Ready
                    </h2>
                    <button
                      onClick={handleEditApps}
                      className="flex items-center gap-2 px-4 py-2 bg-white/10 hover:bg-white/20 border border-white/20 rounded-xl text-sm text-white/80 hover:text-white transition-all"
                    >
                      <Plus className="w-4 h-4" />
                      Add Apps
                    </button>
                  </div>

                  {/* Command bar (AI-powered) */}
                  <div className="relative group">
                    <div className="absolute -inset-1 bg-white/30 rounded-2xl blur opacity-25 group-hover:opacity-50 transition duration-1000 group-hover:duration-200"></div>
                    <div className="relative flex items-center bg-black/80 backdrop-blur-xl border border-white/10 rounded-2xl p-4 gap-3">
                      <Search className="w-6 h-6 text-gray-400" />
                      <input
                        type="text"
                        placeholder='Ask: "Open Frappe welcome page, summarize it, send to Slack, and schedule a meeting"...'
                        className="bg-transparent border-none outline-none text-xl w-full text-white placeholder-gray-500"
                        value={command}
                        onChange={(e) => setCommand(e.target.value)}
                        onKeyDown={handleCommandKeyDown}
                        autoFocus
                      />
                      <button
                        onClick={() => handleRunCommand(false)}
                        className="px-4 py-1 rounded-full bg-white/15 hover:bg-white/25 text-sm font-medium"
                      >
                        Run
                      </button>
                      <button
                        onClick={handleDailyPlanner}
                        disabled={isLoading}
                        className="px-4 py-1 rounded-full bg-blue-500/30 hover:bg-blue-500/50 text-sm font-medium flex items-center gap-1 disabled:opacity-50"
                        title="Generate your personalized daily plan"
                      >
                        📅 Plan
                      </button>
                    </div>
                  </div>

                  {/* App Selection for Ambiguous Requests (kept, though /assistant doesn’t use it now) */}
                  {appChoices.length > 0 && (
                    <div className="mt-6 border border-white/10 rounded-2xl bg-black/70 backdrop-blur-xl p-4">
                      <div className="text-sm font-semibold mb-3 text-white/80">
                        Select an app:
                      </div>
                      <div className="flex gap-4">
                        {appChoices.map((appId) => {
                          const app = [...INITIAL_LEFT_APPS, ...INITIAL_RIGHT_APPS].find(a => a.id === appId);
                          return (
                            <button
                              key={appId}
                              // You could wire this to a more specific flow later
                              onClick={() => setMessages(prev => [...prev, { role: 'assistant', text: `You picked ${app?.name || appId}.` }])}
                              className="flex flex-col items-center gap-2 p-2 rounded-xl hover:bg-white/10 transition-colors"
                            >
                              <div className="w-12 h-12 bg-white rounded-lg p-2">
                                {app ? (
                                  <img src={app.logo} alt={app.name} className="w-full h-full object-contain" />
                                ) : (
                                  <div className="w-full h-full bg-gray-500 rounded" />
                                )}
                              </div>
                              <span className="text-xs text-white/70">{app?.name || appId}</span>
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  )}

                  {/* Follow-up indicator - show when waiting for user response */}
                  {followupContext && followupContext.pendingFields && (
                    <div className="mt-2 px-4 py-2 bg-blue-500/20 border border-blue-400/30 rounded-xl">
                      <p className="text-xs text-blue-300">
                        Waiting for your response... Just type your answer above!
                      </p>
                    </div>
                  )}

                  {/* Chat history */}
                  <div className="mt-6 border border-white/10 rounded-2xl bg-black/70 backdrop-blur-xl p-4 max-h-72 overflow-y-auto">
                    {messages.length === 0 ? (
                      <p className="text-xs text-white/60">
                        Try something like: "Open the Frappe Cloud welcome page, summarize what you see, send that summary to Slack, and schedule a meeting at 3pm today."
                      </p>
                    ) : (
                      messages.map((m, idx) => (
                        <div
                          key={idx}
                          className={`mb-3 flex ${m.role === 'user' ? 'justify-end' : 'justify-start'
                            }`}
                        >
                          <div
                            className={`px-3 py-2 rounded-2xl text-xs max-w-[80%] ${m.role === 'user'
                              ? 'bg-white text-black'
                              : 'bg-white/10 text-white'
                              }`}
                          >
                            {m.role === 'assistant' ? renderMarkdown(m.text) : m.text}
                            {/* Show connect buttons if auth is required */}
                            {m.authRequired && m.toolkits && m.toolkits.length > 0 && (
                              <div className="mt-3 flex flex-wrap gap-2">
                                {m.toolkits.map((toolkit) => (
                                  <button
                                    key={toolkit}
                                    onClick={() => handleConnectApp(toolkit).catch(() => {})}
                                    className="px-3 py-1.5 bg-blue-500 hover:bg-blue-600 text-white rounded-lg text-xs font-medium transition-colors"
                                  >
                                    Connect {toolkit.replace('GOOGLE', 'Google ')}
                                  </button>
                                ))}
                              </div>
                            )}

                            {/* Show re-login button if session expired */}
                            {m.loginRequired && (
                              <div className="mt-3">
                                <button
                                  onClick={() => {
                                    // Force logout and redirect to login
                                    logout();
                                  }}
                                  className="px-4 py-2 bg-orange-500 hover:bg-orange-600 text-white rounded-lg text-sm font-medium transition-colors flex items-center gap-2"
                                >
                                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 16l-4-4m0 0l4-4m-4 4h14m-5 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h7a3 3 0 013 3v1" />
                                  </svg>
                                  Log In Again
                                </button>
                              </div>
                            )}

                            {/* Show OAuth connect button with direct URL */}
                            {m.oauthRequired && m.oauthUrl && (
                              <div className="mt-3">
                                <button
                                  onClick={() => {
                                    const popup = window.open(m.oauthUrl, '_blank', 'width=600,height=700');

                                    // Poll for connection status if we have a connectionId
                                    if (m.connectionId) {
                                      const pollInterval = setInterval(async () => {
                                        try {
                                          const checkResponse = await fetch(`${API_URL}/api/connections/check/${m.connectionId}`);
                                          const checkData = await checkResponse.json();
                                          if (checkData.isActive) {
                                            clearInterval(pollInterval);
                                            setMessages(prev => [...prev, {
                                              role: 'assistant',
                                              text: `✅ Successfully connected to ${m.toolkit?.replace('GOOGLE', 'Google ') || 'the service'}! You can now try your request again.`
                                            }]);
                                            if (popup && !popup.closed) popup.close();
                                          }
                                        } catch (err) {
                                          console.log('[OAuth] Poll error:', err);
                                        }
                                      }, 2000);
                                      // Stop polling after 2 minutes
                                      setTimeout(() => clearInterval(pollInterval), 120000);
                                    }
                                  }}
                                  className="px-4 py-2 bg-blue-500 hover:bg-blue-600 text-white rounded-lg text-sm font-medium transition-colors flex items-center gap-2"
                                >
                                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" />
                                  </svg>
                                  Connect {m.toolkit?.replace('GOOGLE', 'Google ') || 'Account'}
                                </button>
                              </div>
                            )}

                            {/* Show brain recommendations - task list with checkboxes */}
                            {m.brainRecommendations && (
                              <div className="mt-4 w-full">
                                {/* Summary bar */}
                                {m.summary && (
                                  <div className="mb-4 px-4 py-2 bg-white/5 rounded-lg text-sm text-white/70 border border-white/10">
                                    {m.summary}
                                  </div>
                                )}

                                {/* Task list */}
                                {m.tasks && m.tasks.length > 0 ? (
                                  <div className="space-y-2">
                                    {m.tasks.map((task) => (
                                      <div
                                        key={task.id}
                                        className={`flex items-start gap-3 p-3 rounded-lg border transition-all cursor-pointer hover:bg-white/10 ${checkedTasks[task.id]
                                          ? 'bg-white/5 border-green-500/30'
                                          : 'bg-white/5 border-white/10'
                                          }`}
                                        onClick={() => setCheckedTasks(prev => ({
                                          ...prev,
                                          [task.id]: !prev[task.id]
                                        }))}
                                      >
                                        {/* Checkbox */}
                                        <div className={`mt-0.5 w-5 h-5 rounded border-2 flex items-center justify-center flex-shrink-0 ${checkedTasks[task.id]
                                          ? 'bg-green-500 border-green-500'
                                          : 'border-white/30'
                                          }`}>
                                          {checkedTasks[task.id] && (
                                            <svg className="w-3 h-3 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
                                            </svg>
                                          )}
                                        </div>

                                        {/* Task content */}
                                        <div className="flex-1 min-w-0">
                                          <div className={`text-sm font-medium ${checkedTasks[task.id] ? 'line-through text-white/50' : 'text-white'
                                            }`}>
                                            {task.title}
                                          </div>
                                          {task.description && (
                                            <div className="text-xs text-white/50 mt-1 truncate">
                                              {task.description}
                                            </div>
                                          )}
                                          {task.attendees && (
                                            <div className="text-xs text-white/40 mt-1">
                                              Attendees: {task.attendees}
                                            </div>
                                          )}
                                        </div>

                                        {/* Source badge and time */}
                                        <div className="flex flex-col items-end gap-1 flex-shrink-0">
                                          <span className={`px-2 py-0.5 text-xs rounded-full ${task.source === 'calendar' ? 'bg-blue-500/20 text-blue-300' :
                                            task.source === 'jira' ? 'bg-purple-500/20 text-purple-300' :
                                              task.source === 'gmail' ? 'bg-red-500/20 text-red-300' :
                                                'bg-gray-500/20 text-gray-300'
                                            }`}>
                                            {task.sourceIcon} {task.source.toUpperCase()}
                                          </span>
                                          {task.dueTime && (
                                            <span className="text-xs text-white/50">{task.dueTime}</span>
                                          )}
                                          {task.status && (
                                            <span className="text-xs text-white/40">{task.status}</span>
                                          )}
                                          {task.priority === 'high' && (
                                            <span className="text-xs text-red-400">HIGH</span>
                                          )}
                                        </div>
                                      </div>
                                    ))}
                                  </div>
                                ) : (
                                  <div className="text-center py-4 text-white/50 text-sm">
                                    You're all caught up! No pending items found.
                                  </div>
                                )}

                                {/* Execute button - show if any tasks are checked */}
                                {m.tasks && m.tasks.length > 0 && Object.values(checkedTasks).some(v => v) && (
                                  <div className="mt-4 flex justify-end">
                                    <button
                                      onClick={async () => {
                                        const selectedTasks = m.tasks.filter(t => checkedTasks[t.id]);
                                        const checkedCount = selectedTasks.length;

                                        // Show processing message
                                        setMessages(prev => [
                                          ...prev,
                                          {
                                            role: 'assistant',
                                            text: `Processing ${checkedCount} task${checkedCount > 1 ? 's' : ''}...`,
                                          }
                                        ]);

                                        try {
                                          const res = await fetch(`${API_URL}/api/brain/execute`, {
                                            method: 'POST',
                                            headers: {
                                              'Content-Type': 'application/json',
                                              ...(accessToken && { Authorization: `Bearer ${accessToken}` }),
                                            },
                                            body: JSON.stringify({ tasks: selectedTasks }),
                                          });

                                          const data = await res.json();

                                          if (data.summary) {
                                            const resultMessages = data.results
                                              .map(r => `${r.success ? '✓' : '✗'} ${r.message}`)
                                              .join('\n');

                                            setMessages(prev => [
                                              ...prev.slice(0, -1), // Remove "Processing..." message
                                              {
                                                role: 'assistant',
                                                text: `Done! ${data.summary.success}/${data.summary.total} tasks completed:\n\n${resultMessages}`,
                                              }
                                            ]);
                                          }
                                        } catch (err) {
                                          setMessages(prev => [
                                            ...prev.slice(0, -1),
                                            {
                                              role: 'assistant',
                                              text: `Error executing tasks: ${err.message}`,
                                            }
                                          ]);
                                        }

                                        setCheckedTasks({});
                                      }}
                                      className="px-4 py-2 bg-green-600 hover:bg-green-700 text-white text-sm font-medium rounded-lg transition-colors flex items-center gap-2"
                                    >
                                      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                                      </svg>
                                      Mark Complete ({Object.values(checkedTasks).filter(v => v).length})
                                    </button>
                                  </div>
                                )}
                              </div>
                            )}

                            {/* Show guidance/how-to steps */}
                            {m.guidance && (
                              <div className="mt-4 w-full">
                                {/* Title with app badge */}
                                <div className="flex items-center gap-3 mb-4">
                                  <div className="text-lg font-semibold text-white">
                                    {m.title || 'Step-by-Step Guide'}
                                  </div>
                                  {m.appName && (
                                    <span className="px-2 py-1 text-xs bg-blue-500/20 text-blue-300 rounded-full">
                                      {m.appName}
                                    </span>
                                  )}
                                </div>

                                {/* Steps */}
                                {m.steps && m.steps.length > 0 ? (
                                  <div className="space-y-3">
                                    {m.steps.map((step, idx) => (
                                      <div
                                        key={idx}
                                        className="flex gap-3 p-3 bg-white/5 rounded-lg border border-white/10"
                                      >
                                        <div className="flex-shrink-0 w-7 h-7 rounded-full bg-blue-500/20 text-blue-300 flex items-center justify-center text-sm font-bold">
                                          {step.number || idx + 1}
                                        </div>
                                        <div className="flex-1">
                                          <div className="text-sm font-medium text-white">
                                            {step.action}
                                          </div>
                                          {step.detail && (
                                            <div className="text-xs text-white/60 mt-1">
                                              {step.detail}
                                            </div>
                                          )}
                                        </div>
                                      </div>
                                    ))}
                                  </div>
                                ) : m.raw ? (
                                  <div className="text-sm text-white/80 whitespace-pre-wrap">
                                    {m.text}
                                  </div>
                                ) : null}

                                {/* Tips section */}
                                {m.tips && m.tips.length > 0 && (
                                  <div className="mt-4 p-3 bg-yellow-500/10 rounded-lg border border-yellow-500/20">
                                    <div className="text-sm font-medium text-yellow-300 mb-2">
                                      💡 Tips
                                    </div>
                                    <ul className="text-xs text-yellow-200/70 space-y-1 list-disc list-inside">
                                      {m.tips.map((tip, idx) => (
                                        <li key={idx}>{tip}</li>
                                      ))}
                                    </ul>
                                  </div>
                                )}

                                {/* Documentation link */}
                                {m.docLink && (
                                  <div className="mt-4 flex items-center gap-2">
                                    <a
                                      href={m.docLink}
                                      target="_blank"
                                      rel="noopener noreferrer"
                                      className="text-xs text-blue-400 hover:text-blue-300 flex items-center gap-1"
                                    >
                                      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                                      </svg>
                                      View Documentation
                                    </a>
                                  </div>
                                )}

                                {/* Automation hint */}
                                {m.canAutomate && (
                                  <div className="mt-3 p-2 bg-green-500/10 rounded-lg border border-green-500/20 text-xs text-green-300">
                                    ✨ SwiftCollab can help automate parts of this process!
                                  </div>
                                )}
                              </div>
                            )}
                          </div>
                        </div>
                      ))
                    )}
                    <div ref={messagesEndRef} />
                  </div>

                  <div className="mt-12 flex justify-center gap-4 flex-wrap">
                    {[...aiOsApps, ...workOsApps].slice(0, 5).map((app, i) => (
                      <motion.div
                        key={app.id}
                        initial={{ opacity: 0, scale: 0 }}
                        animate={{ opacity: 1, scale: 1 }}
                        transition={{ delay: i * 0.1 + 0.5 }}
                        className="w-16 h-16 rounded-xl bg-white border border-white/10 flex items-center justify-center p-2"
                      >
                        <img
                          src={app.logo}
                          alt={app.name}
                          className="w-full h-full object-contain"
                          onError={(e) => {
                            e.target.style.display = 'none';
                            e.target.nextSibling.style.display = 'flex';
                          }}
                        />
                        <div className="w-full h-full items-center justify-center text-gray-600 font-bold text-xl hidden">
                          {app.name?.charAt(0) || '?'}
                        </div>
                      </motion.div>
                    ))}
                    {aiOsApps.length + workOsApps.length > 5 && (
                      <div className="w-16 h-16 rounded-xl bg-white/5 border border-white/10 flex items-center justify-center text-sm text-gray-400">
                        +{aiOsApps.length + workOsApps.length - 5}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Global Tooltip */}
        <AnimatePresence>
          {tooltip.visible && (
            <motion.div
              initial={{ opacity: 0, scale: 0.9 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.9 }}
              className="fixed z-50 pointer-events-none"
              style={{
                top: tooltip.y,
                left: tooltip.x,
                transform: 'translateY(-50%)',
              }}
            >
              <div
                className={`bg-black/90 backdrop-blur-md border border-white/10 text-white text-sm py-2 px-4 rounded-lg whitespace-nowrap shadow-xl ${tooltip.side === 'right' ? '-translate-x-full' : ''
                  }`}
              >
                {tooltip.text}
                {/* Arrow */}
                <div
                  className={`absolute top-1/2 transform -translate-y-1/2 ${tooltip.side === 'left'
                    ? 'left-0 -ml-1 border-r-4 border-r-black/90'
                    : 'right-0 -mr-1 border-l-4 border-l-black/90'
                    } border-y-4 border-y-transparent h-0 w-0`}
                />
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* OAuth Configuration Modal */}
        <AnimatePresence>
          {oauthConfigModal.visible && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center"
              onClick={() => setOauthConfigModal(prev => ({ ...prev, visible: false }))}
            >
              <motion.div
                initial={{ scale: 0.9, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                exit={{ scale: 0.9, opacity: 0 }}
                className="bg-gray-900 border border-white/10 rounded-xl p-6 max-w-md w-full mx-4 shadow-2xl"
                onClick={e => e.stopPropagation()}
              >
                <h2 className="text-xl font-semibold text-white mb-2">
                  Configure {oauthConfigModal.toolkit.toUpperCase()}
                </h2>
                <p className="text-gray-400 text-sm mb-4">
                  This app requires OAuth credentials to connect. Follow the steps below to set it up.
                </p>

                {/* App-Specific Instructions */}
                {oauthConfigModal.toolkit.toLowerCase() === 'jira' && (
                  <div className="bg-blue-900/30 border border-blue-500/30 rounded-lg p-4 mb-4 text-sm">
                    <p className="text-blue-300 font-semibold mb-2">📋 JIRA Setup Instructions:</p>
                    <ol className="text-blue-200 space-y-2 list-decimal list-inside">
                      <li>Go to <a href="https://developer.atlassian.com/console/myapps/" target="_blank" rel="noopener noreferrer" className="text-cyan-400 underline hover:text-cyan-300">Atlassian Developer Console</a></li>
                      <li>Click <strong>"Create"</strong> → <strong>"OAuth 2.0 integration"</strong></li>
                      <li>Enter a name (e.g., "SwiftCollab") and click Create</li>
                      <li>Go to <strong>"Permissions"</strong> tab → Add <strong>"Jira API"</strong> permissions</li>
                      <li>Go to <strong>"Authorization"</strong> tab → Click <strong>"Configure"</strong></li>
                      <li>Set Callback URL to:</li>
                    </ol>
                    <code className="block bg-black/40 px-3 py-2 rounded mt-2 text-xs text-cyan-300 break-all">
                      {oauthConfigModal.redirectUri}
                    </code>
                    <ol start={7} className="text-blue-200 space-y-2 list-decimal list-inside mt-2">
                      <li>Go to <strong>"Settings"</strong> tab → Copy <strong>Client ID</strong> and <strong>Secret</strong></li>
                      <li>Paste them below and click "Save & Connect"</li>
                    </ol>
                  </div>
                )}

                {oauthConfigModal.toolkit.toLowerCase() === 'github' && (
                  <div className="bg-blue-900/30 border border-blue-500/30 rounded-lg p-4 mb-4 text-sm">
                    <p className="text-blue-300 font-semibold mb-2">🐙 GitHub Setup Instructions:</p>
                    <ol className="text-blue-200 space-y-2 list-decimal list-inside">
                      <li>Go to <a href="https://github.com/settings/developers" target="_blank" rel="noopener noreferrer" className="text-cyan-400 underline hover:text-cyan-300">GitHub Developer Settings</a></li>
                      <li>Click <strong>"New OAuth App"</strong></li>
                      <li>Enter Application name: "SwiftCollab"</li>
                      <li>Homepage URL: <code className="bg-black/30 px-1 rounded">http://localhost:5173</code></li>
                      <li>Authorization callback URL:</li>
                    </ol>
                    <code className="block bg-black/40 px-3 py-2 rounded mt-2 text-xs text-cyan-300 break-all">
                      {oauthConfigModal.redirectUri}
                    </code>
                    <ol start={6} className="text-blue-200 space-y-2 list-decimal list-inside mt-2">
                      <li>Click "Register application"</li>
                      <li>Copy <strong>Client ID</strong> and generate a <strong>Client Secret</strong></li>
                      <li>Paste them below and click "Save & Connect"</li>
                    </ol>
                  </div>
                )}

                {oauthConfigModal.toolkit.toLowerCase() === 'asana' && (
                  <div className="bg-blue-900/30 border border-blue-500/30 rounded-lg p-4 mb-4 text-sm">
                    <p className="text-blue-300 font-semibold mb-2">✅ Asana Setup Instructions:</p>
                    <ol className="text-blue-200 space-y-2 list-decimal list-inside">
                      <li>Go to <a href="https://app.asana.com/0/developer-console" target="_blank" rel="noopener noreferrer" className="text-cyan-400 underline hover:text-cyan-300">Asana Developer Console</a></li>
                      <li>Click <strong>"Create new app"</strong></li>
                      <li>Enter App name: "SwiftCollab"</li>
                      <li>Go to <strong>"OAuth"</strong> section</li>
                      <li>Add Redirect URL:</li>
                    </ol>
                    <code className="block bg-black/40 px-3 py-2 rounded mt-2 text-xs text-cyan-300 break-all">
                      {oauthConfigModal.redirectUri}
                    </code>
                    <ol start={6} className="text-blue-200 space-y-2 list-decimal list-inside mt-2">
                      <li>Copy <strong>Client ID</strong> and <strong>Client Secret</strong></li>
                      <li>Paste them below and click "Save & Connect"</li>
                    </ol>
                  </div>
                )}

                {oauthConfigModal.toolkit.toLowerCase() === 'notion' && (
                  <div className="bg-blue-900/30 border border-blue-500/30 rounded-lg p-4 mb-4 text-sm">
                    <p className="text-blue-300 font-semibold mb-2">📝 Notion Setup Instructions:</p>
                    <ol className="text-blue-200 space-y-2 list-decimal list-inside">
                      <li>Go to <a href="https://www.notion.so/my-integrations" target="_blank" rel="noopener noreferrer" className="text-cyan-400 underline hover:text-cyan-300">Notion Integrations</a></li>
                      <li>Click <strong>"New integration"</strong></li>
                      <li>Enter name: "SwiftCollab", select workspace</li>
                      <li>Set Type to <strong>"Public"</strong> for OAuth</li>
                      <li>Add Redirect URI:</li>
                    </ol>
                    <code className="block bg-black/40 px-3 py-2 rounded mt-2 text-xs text-cyan-300 break-all">
                      {oauthConfigModal.redirectUri}
                    </code>
                    <ol start={6} className="text-blue-200 space-y-2 list-decimal list-inside mt-2">
                      <li>Copy <strong>OAuth client ID</strong> and <strong>OAuth client secret</strong></li>
                      <li>Paste them below and click "Save & Connect"</li>
                    </ol>
                  </div>
                )}

                {/* Generic instructions for other apps */}
                {!['jira', 'github', 'asana', 'notion'].includes(oauthConfigModal.toolkit.toLowerCase()) && (
                  <div className="bg-blue-900/30 border border-blue-500/30 rounded-lg p-4 mb-4 text-sm">
                    <p className="text-blue-300 font-semibold mb-2">🔧 Setup Instructions:</p>
                    <ol className="text-blue-200 space-y-2 list-decimal list-inside">
                      <li>Go to {oauthConfigModal.toolkit}'s developer portal/console</li>
                      <li>Create a new OAuth 2.0 application</li>
                      <li>Set the Redirect/Callback URL to:</li>
                    </ol>
                    <code className="block bg-black/40 px-3 py-2 rounded mt-2 text-xs text-cyan-300 break-all">
                      {oauthConfigModal.redirectUri}
                    </code>
                    <ol start={4} className="text-blue-200 space-y-2 list-decimal list-inside mt-2">
                      <li>Copy the <strong>Client ID</strong> and <strong>Client Secret</strong></li>
                      <li>Paste them below and click "Save & Connect"</li>
                    </ol>
                  </div>
                )}

                {/* Dynamic Fields */}
                <div className="space-y-3">
                  {oauthConfigModal.fields
                    .filter(field => field.required)
                    .map(field => (
                      <div key={field.name}>
                        <label className="block text-sm text-gray-300 mb-1">
                          {field.displayName} {field.required && <span className="text-red-400">*</span>}
                        </label>
                        <input
                          type={field.name.includes('secret') ? 'password' : 'text'}
                          placeholder={field.description}
                          value={oauthConfigModal.credentials[field.name] || ''}
                          onChange={e => setOauthConfigModal(prev => ({
                            ...prev,
                            credentials: { ...prev.credentials, [field.name]: e.target.value }
                          }))}
                          className="w-full bg-black/50 border border-white/10 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-cyan-500/50"
                        />
                      </div>
                    ))}
                </div>

                {/* Error Message */}
                {oauthConfigModal.error && (
                  <div className="mt-3 p-2 bg-red-900/30 border border-red-500/30 rounded text-red-300 text-sm">
                    {oauthConfigModal.error}
                  </div>
                )}

                {/* Buttons */}
                <div className="flex gap-3 mt-5">
                  <button
                    onClick={() => setOauthConfigModal(prev => ({ ...prev, visible: false }))}
                    className="flex-1 py-2 px-4 bg-gray-700 hover:bg-gray-600 text-white rounded-lg text-sm transition-colors"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={handleOAuthConfigSubmit}
                    disabled={oauthConfigModal.loading}
                    className="flex-1 py-2 px-4 bg-cyan-600 hover:bg-cyan-500 disabled:bg-cyan-800 disabled:cursor-not-allowed text-white rounded-lg text-sm transition-colors"
                  >
                    {oauthConfigModal.loading ? 'Saving...' : 'Save & Connect'}
                  </button>
                </div>
              </motion.div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Connection Params Modal (for subdomain, etc.) */}
        <AnimatePresence>
          {connectionParamsModal.visible && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center"
              onClick={() => setConnectionParamsModal(prev => ({ ...prev, visible: false }))}
            >
              <motion.div
                initial={{ scale: 0.9, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                exit={{ scale: 0.9, opacity: 0 }}
                className="bg-gray-900 border border-white/10 rounded-xl p-6 max-w-md w-full mx-4 shadow-2xl"
                onClick={e => e.stopPropagation()}
              >
                <h2 className="text-xl font-semibold text-white mb-2">
                  Connect {connectionParamsModal.toolkit.toUpperCase()}
                </h2>
                <p className="text-gray-400 text-sm mb-4">
                  Please provide the following information to connect your account.
                </p>

                {/* JIRA-specific instructions */}
                {connectionParamsModal.toolkit.toLowerCase() === 'jira' && (
                  <div className="bg-blue-900/30 border border-blue-500/30 rounded-lg p-3 mb-4">
                    <p className="text-blue-300 text-xs">
                      <strong>Your JIRA subdomain</strong> is the first part of your Atlassian URL.<br />
                      For example, if your JIRA is at <code className="bg-black/30 px-1 rounded">mycompany.atlassian.net</code>,
                      enter <code className="bg-black/30 px-1 rounded">mycompany</code> below.
                    </p>
                  </div>
                )}

                {/* Dynamic Fields */}
                <div className="space-y-3">
                  {connectionParamsModal.fields.map(field => (
                    <div key={field.name}>
                      <label className="block text-sm text-gray-300 mb-1">
                        {field.displayName} {field.required && <span className="text-red-400">*</span>}
                      </label>
                      <input
                        type="text"
                        placeholder={field.description}
                        value={connectionParamsModal.params[field.name] || ''}
                        onChange={e => setConnectionParamsModal(prev => ({
                          ...prev,
                          params: { ...prev.params, [field.name]: e.target.value }
                        }))}
                        className="w-full bg-black/50 border border-white/10 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-cyan-500/50"
                      />
                    </div>
                  ))}
                </div>

                {/* Error Message */}
                {connectionParamsModal.error && (
                  <div className="mt-3 p-2 bg-red-900/30 border border-red-500/30 rounded text-red-300 text-sm">
                    {connectionParamsModal.error}
                  </div>
                )}

                {/* Buttons */}
                <div className="flex gap-3 mt-5">
                  <button
                    onClick={() => setConnectionParamsModal(prev => ({ ...prev, visible: false }))}
                    className="flex-1 py-2 px-4 bg-gray-700 hover:bg-gray-600 text-white rounded-lg text-sm transition-colors"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={handleConnectionParamsSubmit}
                    disabled={connectionParamsModal.loading}
                    className="flex-1 py-2 px-4 bg-cyan-600 hover:bg-cyan-500 disabled:bg-cyan-800 disabled:cursor-not-allowed text-white rounded-lg text-sm transition-colors"
                  >
                    {connectionParamsModal.loading ? 'Connecting...' : 'Connect'}
                  </button>
                </div>
              </motion.div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Connect method chooser: Composio sign-in vs API key */}
        <AnimatePresence>
          {connectMethodModal.visible && connectMethodModal.app && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center"
              onClick={() => setConnectMethodModal({ visible: false, app: null, authUrl: null, loading: false, error: null })}
            >
              <motion.div
                initial={{ scale: 0.9, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                exit={{ scale: 0.9, opacity: 0 }}
                className="bg-gray-800 rounded-xl p-6 w-full max-w-md mx-4 shadow-2xl border border-gray-700"
                onClick={e => e.stopPropagation()}
              >
                <h2 className="text-xl font-semibold text-white mb-2">
                  Connect {connectMethodModal.app.name}
                </h2>
                <p className="text-gray-400 text-sm mb-5">
                  Choose how you want to sign in. Composio opens the app&apos;s own login (Google, Slack, and so on). API key is only for apps that give you a key in settings.
                </p>

                <div className="space-y-3">
                  <button
                    onClick={async () => {
                      const { app, authUrl } = connectMethodModal;
                      setConnectMethodModal(prev => ({ ...prev, loading: true, error: null }));
                      try {
                        await startComposioConnect(app, authUrl);
                        setConnectMethodModal({ visible: false, app: null, authUrl: null, loading: false, error: null });
                      } catch (err) {
                        setConnectMethodModal(prev => ({
                          ...prev,
                          loading: false,
                          error: err.message || 'Failed to start Composio sign-in'
                        }));
                      }
                    }}
                    disabled={connectMethodModal.loading}
                    className="w-full text-left p-4 rounded-xl border border-cyan-500/40 bg-cyan-900/20 hover:bg-cyan-900/40 transition-colors disabled:opacity-60"
                  >
                    <div className="flex items-start gap-3">
                      <Link2 className="w-5 h-5 text-cyan-400 mt-0.5 shrink-0" />
                      <div>
                        <div className="text-white font-medium">
                          {connectMethodModal.loading ? 'Opening Composio…' : 'Sign in with Composio'}
                        </div>
                        <div className="text-gray-400 text-sm mt-1">
                          Recommended. Authorize {connectMethodModal.app.name} in a popup — no API key needed.
                        </div>
                      </div>
                    </div>
                  </button>

                  <button
                    onClick={() => {
                      const app = connectMethodModal.app;
                      setConnectMethodModal({ visible: false, app: null, authUrl: null, loading: false, error: null });
                      showApiKeyModal(app.id.toUpperCase(), app.name);
                    }}
                    disabled={connectMethodModal.loading}
                    className="w-full text-left p-4 rounded-xl border border-white/10 bg-white/5 hover:bg-white/10 transition-colors disabled:opacity-60"
                  >
                    <div className="flex items-start gap-3">
                      <Key className="w-5 h-5 text-amber-400 mt-0.5 shrink-0" />
                      <div>
                        <div className="text-white font-medium">Use API key</div>
                        <div className="text-gray-400 text-sm mt-1">
                          Paste a key from {connectMethodModal.app.name} settings if you are not using Composio login.
                        </div>
                      </div>
                    </div>
                  </button>
                </div>

                {connectMethodModal.error && (
                  <div className="mt-4 p-2 bg-red-900/30 border border-red-500/30 rounded text-red-300 text-sm">
                    {connectMethodModal.error}
                  </div>
                )}

                <button
                  onClick={() => setConnectMethodModal({ visible: false, app: null, authUrl: null, loading: false, error: null })}
                  className="mt-5 w-full py-2 px-4 bg-gray-700 hover:bg-gray-600 text-white rounded-lg text-sm transition-colors"
                >
                  Cancel
                </button>
              </motion.div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* API Key Modal (for API_KEY auth apps like Axonaut) */}
        <AnimatePresence>
          {apiKeyModal.visible && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center"
              onClick={() => setApiKeyModal(prev => ({ ...prev, visible: false }))}
            >
              <motion.div
                initial={{ scale: 0.9, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                exit={{ scale: 0.9, opacity: 0 }}
                className="bg-gray-800 rounded-xl p-6 w-full max-w-md mx-4 shadow-2xl border border-gray-700"
                onClick={e => e.stopPropagation()}
              >
                <h2 className="text-xl font-semibold text-white mb-2">
                  Connect {apiKeyModal.appName}
                </h2>
                <p className="text-gray-400 text-sm mb-4">
                  {apiKeyModal.appName} uses API {apiKeyModal.requiresSecret ? 'key and secret' : 'key'} authentication.
                  Enter your credentials to connect.
                </p>

                {/* Instructions */}
                <div className="bg-blue-900/30 border border-blue-500/30 rounded-lg p-4 mb-4 text-sm">
                  <p className="text-blue-300 font-semibold mb-2">How to get your API credentials:</p>
                  <ol className="text-blue-200 space-y-1 list-decimal list-inside">
                    <li>Log into your {apiKeyModal.appName} account</li>
                    <li>Go to <strong>Settings</strong> → <strong>API</strong> or <strong>Integrations</strong></li>
                    <li>Generate or copy your API key{apiKeyModal.requiresSecret ? ' and secret' : ''}</li>
                    <li>Paste {apiKeyModal.requiresSecret ? 'them' : 'it'} below and click "Save & Connect"</li>
                  </ol>
                </div>

                {/* API Key Input */}
                <div className="mb-4">
                  <label className="block text-sm text-gray-300 mb-1">
                    API Key <span className="text-red-400">*</span>
                  </label>
                  <input
                    type="password"
                    placeholder={`Enter your ${apiKeyModal.appName} API key`}
                    value={apiKeyModal.apiKey}
                    onChange={e => setApiKeyModal(prev => ({ ...prev, apiKey: e.target.value }))}
                    className="w-full px-3 py-2 bg-gray-900 border border-gray-600 rounded-lg text-white text-sm focus:outline-none focus:border-cyan-500"
                    autoFocus
                  />
                </div>

                {/* API Secret Input (for apps like Frappe that need both) */}
                {apiKeyModal.requiresSecret && (
                  <div className="mb-4">
                    <label className="block text-sm text-gray-300 mb-1">
                      API Secret <span className="text-red-400">*</span>
                    </label>
                    <input
                      type="password"
                      placeholder={`Enter your ${apiKeyModal.appName} API secret`}
                      value={apiKeyModal.apiSecret}
                      onChange={e => setApiKeyModal(prev => ({ ...prev, apiSecret: e.target.value }))}
                      className="w-full px-3 py-2 bg-gray-900 border border-gray-600 rounded-lg text-white text-sm focus:outline-none focus:border-cyan-500"
                    />
                  </div>
                )}

                {/* Error Message */}
                {apiKeyModal.error && (
                  <div className="mb-4 p-2 bg-red-900/30 border border-red-500/30 rounded text-red-300 text-sm">
                    {apiKeyModal.error}
                  </div>
                )}

                {/* Buttons */}
                <div className="flex gap-3">
                  <button
                    onClick={() => setApiKeyModal(prev => ({ ...prev, visible: false }))}
                    className="flex-1 py-2 px-4 bg-gray-700 hover:bg-gray-600 text-white rounded-lg text-sm transition-colors"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={handleApiKeySubmit}
                    disabled={apiKeyModal.loading || !apiKeyModal.apiKey.trim() || (apiKeyModal.requiresSecret && !apiKeyModal.apiSecret.trim())}
                    className="flex-1 py-2 px-4 bg-cyan-600 hover:bg-cyan-500 disabled:bg-cyan-800 disabled:cursor-not-allowed text-white rounded-lg text-sm transition-colors"
                  >
                    {apiKeyModal.loading ? 'Saving...' : 'Save & Connect'}
                  </button>
                </div>
              </motion.div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* ERPNext Connect Modal */}
        <ERPNextConnectModal
          visible={erpNextModalVisible}
          onClose={() => setErpNextModalVisible(false)}
          onSuccess={handleErpNextConnectSuccess}
          accessToken={accessToken}
        />
      </div>
    </div>
  );
}

// Wrapper component that checks authentication and loads workspace
function AppWithAuth() {
  const { isAuthenticated, loading, user, logout, accessToken, organizations, activeOrganization, setActiveOrganization } = useAuth();
  const [workspace, setWorkspace] = useState(null);
  const [workspaceLoading, setWorkspaceLoading] = useState(true);
  const [showInterviewScheduling, setShowInterviewScheduling] = useState(false);
  const [showOrganizationTeam, setShowOrganizationTeam] = useState(false);

  // Load workspace when authenticated
  useEffect(() => {
    async function loadWorkspace() {
      if (!isAuthenticated || !accessToken) {
        setWorkspaceLoading(false);
        return;
      }

      try {
        const response = await fetch(`${API_URL}/api/workspace`, {
          headers: {
            'Authorization': `Bearer ${accessToken}`,
          },
        });

        if (response.ok) {
          const data = await response.json();
          console.log('[Workspace] Loaded:', data);
          setWorkspace(data);
        }
      } catch (err) {
        console.error('[Workspace] Load error:', err);
      } finally {
        setWorkspaceLoading(false);
      }
    }

    loadWorkspace();
  }, [isAuthenticated, accessToken]);

  if (loading || workspaceLoading) {
    return (
      <div className="min-h-screen bg-gray-900 flex items-center justify-center">
        <div className="text-center">
          <div className="w-16 h-16 border-4 border-blue-500 border-t-transparent rounded-full animate-spin mx-auto mb-4" />
          <p className="text-gray-400">Loading...</p>
        </div>
      </div>
    );
  }

  if (!isAuthenticated) {
    return <LoginPage onSuccess={() => window.location.reload()} />;
  }

  return (
    <div className="relative">
      {/* User menu in top-right corner */}
      <div className="fixed top-4 right-4 z-50 flex items-center gap-3">
        <button
          onClick={() => setShowOrganizationTeam(true)}
          className="px-3 py-2 bg-gray-800/80 hover:bg-gray-700 rounded-lg border border-gray-600 text-sm text-white"
        >
          {activeOrganization?.organization_name || 'Organization'} · {activeOrganization?.role || 'role'}
        </button>
        <button
          onClick={() => setShowInterviewScheduling(true)}
          className="px-3 py-2 bg-cyan-700/80 hover:bg-cyan-600 rounded-lg border border-cyan-400/30 text-sm text-white"
        >
          Schedule interviews
        </button>
        <div className="flex items-center gap-2 px-3 py-2 bg-gray-800/80 backdrop-blur-sm rounded-lg border border-gray-700/50">
          <User className="w-4 h-4 text-gray-400" />
          <span className="text-sm text-gray-300">{user?.name || user?.email}</span>
        </div>
        <button
          onClick={logout}
          className="p-2 bg-gray-800/80 backdrop-blur-sm rounded-lg border border-gray-700/50 text-gray-400 hover:text-white hover:bg-red-500/20 hover:border-red-500/50 transition-all"
          title="Sign out"
        >
          <LogOut className="w-4 h-4" />
        </button>
      </div>
      <App
        key={workspace?.updatedAt || 'no-workspace'}
        initialWorkspace={workspace}
        onWorkspaceChange={() => {
          // Reload workspace after changes
          setWorkspaceLoading(true);
          fetch(`${API_URL}/api/workspace`, {
            headers: { 'Authorization': `Bearer ${accessToken}` },
          })
            .then(r => r.json())
            .then(data => setWorkspace(data))
            .finally(() => setWorkspaceLoading(false));
        }}
      />
      {showInterviewScheduling && <InterviewSchedulingPanel onClose={() => setShowInterviewScheduling(false)} />}
      {showOrganizationTeam && <OrganizationTeamPanel
        organizations={organizations}
        activeOrganization={activeOrganization}
        setActiveOrganization={setActiveOrganization}
        onClose={() => setShowOrganizationTeam(false)}
      />}
    </div>
  );
}

// Main export with AuthProvider
export default function AppRoot() {
  return (
    <AuthProvider>
      <AppWithAuth />
    </AuthProvider>
  );
}
