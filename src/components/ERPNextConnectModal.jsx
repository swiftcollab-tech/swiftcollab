import React, { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { X, CheckCircle, AlertCircle, Loader2, ExternalLink, Server, Key, Lock } from 'lucide-react';
import { API_URL } from '../services/api';

/**
 * ERPNextConnectModal - Modal for connecting user's ERPNext instance
 *
 * Features:
 * - Base URL input
 * - API Key / Secret inputs
 * - Test connection before saving
 * - Clear instructions for users
 */
const ERPNextConnectModal = ({ visible, onClose, onSuccess, accessToken }) => {
  const [formData, setFormData] = useState({
    baseUrl: '',
    apiKey: '',
    apiSecret: '',
    connectionName: 'Default ERPNext'
  });

  const [testResult, setTestResult] = useState(null); // { success, message, user, company }
  const [loading, setLoading] = useState(false);
  const [testing, setTesting] = useState(false);
  const [error, setError] = useState(null);

  const handleChange = (field, value) => {
    setFormData(prev => ({ ...prev, [field]: value }));
    setTestResult(null); // Clear test result when form changes
    setError(null);
  };

  const handleTestConnection = async () => {
    if (!formData.baseUrl || !formData.apiKey || !formData.apiSecret) {
      setError('Please fill in all fields');
      return;
    }

    setTesting(true);
    setError(null);
    setTestResult(null);

    try {
      const response = await fetch(`${API_URL}/api/frappe/test-connection`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${accessToken}`
        },
        body: JSON.stringify({
          baseUrl: formData.baseUrl.trim(),
          apiKey: formData.apiKey.trim(),
          apiSecret: formData.apiSecret.trim()
        })
      });

      const data = await response.json();

      if (data.success) {
        setTestResult({
          success: true,
          message: 'Connection successful!',
          user: data.user,
          company: data.company
        });
      } else {
        setTestResult({
          success: false,
          message: data.error || 'Connection failed'
        });
      }
    } catch (err) {
      setTestResult({
        success: false,
        message: err.message || 'Failed to test connection'
      });
    } finally {
      setTesting(false);
    }
  };

  const handleConnect = async () => {
    if (!formData.baseUrl || !formData.apiKey || !formData.apiSecret) {
      setError('Please fill in all fields');
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const response = await fetch(`${API_URL}/api/frappe/connect`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${accessToken}`
        },
        body: JSON.stringify({
          baseUrl: formData.baseUrl.trim(),
          apiKey: formData.apiKey.trim(),
          apiSecret: formData.apiSecret.trim(),
          connectionName: formData.connectionName
        })
      });

      const data = await response.json();

      if (data.success) {
        onSuccess?.({
          connection: data.connection,
          erpUser: data.erpUser,
          erpCompany: data.erpCompany
        });
        onClose();
      } else {
        setError(data.error || 'Failed to connect');
      }
    } catch (err) {
      setError(err.message || 'Failed to connect');
    } finally {
      setLoading(false);
    }
  };

  const isFormValid = formData.baseUrl.trim() && formData.apiKey.trim() && formData.apiSecret.trim();

  if (!visible) return null;

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4"
        onClick={onClose}
      >
        <motion.div
          initial={{ scale: 0.9, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          exit={{ scale: 0.9, opacity: 0 }}
          className="bg-gray-800 rounded-xl w-full max-w-lg shadow-2xl border border-gray-700 overflow-hidden"
          onClick={e => e.stopPropagation()}
        >
          {/* Header */}
          <div className="flex items-center justify-between px-6 py-4 border-b border-gray-700">
            <div className="flex items-center gap-3">
              <img
                src="/logos/frappe.png"
                alt="ERPNext"
                className="w-8 h-8 object-contain"
                onError={(e) => { e.target.style.display = 'none' }}
              />
              <div>
                <h2 className="text-lg font-semibold text-white">Connect ERPNext</h2>
                <p className="text-xs text-gray-400">Connect your Frappe/ERPNext instance</p>
              </div>
            </div>
            <button
              onClick={onClose}
              className="p-1 rounded-lg hover:bg-gray-700 text-gray-400 hover:text-white transition-colors"
            >
              <X size={20} />
            </button>
          </div>

          {/* Content */}
          <div className="p-6 space-y-4">
            {/* Instructions */}
            <div className="bg-blue-900/30 border border-blue-500/30 rounded-lg p-4 text-sm">
              <p className="text-blue-300 font-semibold mb-2 flex items-center gap-2">
                <Key size={16} />
                How to get your API credentials
              </p>
              <ol className="text-blue-200 space-y-1 list-decimal list-inside text-xs">
                <li>Log into your ERPNext as Administrator</li>
                <li>Go to <strong>User</strong> &rarr; <strong>Your User</strong> &rarr; <strong>API Access</strong></li>
                <li>Click <strong>"Generate Keys"</strong> to create API Key and Secret</li>
                <li>Copy the API Key and Secret (Secret is shown only once!)</li>
              </ol>
              <a
                href="https://frappeframework.com/docs/v14/user/en/api/rest#1-token-based-authentication"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 mt-2 text-blue-400 hover:text-blue-300 text-xs"
              >
                Learn more <ExternalLink size={12} />
              </a>
            </div>

            {/* Base URL */}
            <div>
              <label className="flex items-center gap-2 text-sm text-gray-300 mb-1.5">
                <Server size={14} />
                ERPNext URL <span className="text-red-400">*</span>
              </label>
              <input
                type="url"
                placeholder="https://your-site.erpnext.com"
                value={formData.baseUrl}
                onChange={e => handleChange('baseUrl', e.target.value)}
                className="w-full px-3 py-2.5 bg-gray-900 border border-gray-600 rounded-lg text-white text-sm focus:outline-none focus:border-cyan-500 placeholder-gray-500"
              />
              <p className="text-xs text-gray-500 mt-1">
                Your ERPNext instance URL (cloud or self-hosted)
              </p>
            </div>

            {/* API Key */}
            <div>
              <label className="flex items-center gap-2 text-sm text-gray-300 mb-1.5">
                <Key size={14} />
                API Key <span className="text-red-400">*</span>
              </label>
              <input
                type="text"
                placeholder="Enter your API key"
                value={formData.apiKey}
                onChange={e => handleChange('apiKey', e.target.value)}
                className="w-full px-3 py-2.5 bg-gray-900 border border-gray-600 rounded-lg text-white text-sm focus:outline-none focus:border-cyan-500 placeholder-gray-500 font-mono"
              />
            </div>

            {/* API Secret */}
            <div>
              <label className="flex items-center gap-2 text-sm text-gray-300 mb-1.5">
                <Lock size={14} />
                API Secret <span className="text-red-400">*</span>
              </label>
              <input
                type="password"
                placeholder="Enter your API secret"
                value={formData.apiSecret}
                onChange={e => handleChange('apiSecret', e.target.value)}
                className="w-full px-3 py-2.5 bg-gray-900 border border-gray-600 rounded-lg text-white text-sm focus:outline-none focus:border-cyan-500 placeholder-gray-500 font-mono"
              />
            </div>

            {/* Test Result */}
            {testResult && (
              <motion.div
                initial={{ opacity: 0, y: -10 }}
                animate={{ opacity: 1, y: 0 }}
                className={`flex items-start gap-3 p-3 rounded-lg ${
                  testResult.success
                    ? 'bg-green-900/30 border border-green-500/30'
                    : 'bg-red-900/30 border border-red-500/30'
                }`}
              >
                {testResult.success ? (
                  <CheckCircle className="text-green-400 mt-0.5 flex-shrink-0" size={18} />
                ) : (
                  <AlertCircle className="text-red-400 mt-0.5 flex-shrink-0" size={18} />
                )}
                <div className="text-sm">
                  <p className={testResult.success ? 'text-green-300' : 'text-red-300'}>
                    {testResult.message}
                  </p>
                  {testResult.success && testResult.user && (
                    <p className="text-green-200/70 text-xs mt-1">
                      Connected as <strong>{testResult.user}</strong>
                      {testResult.company && <> to <strong>{testResult.company}</strong></>}
                    </p>
                  )}
                </div>
              </motion.div>
            )}

            {/* Error */}
            {error && (
              <motion.div
                initial={{ opacity: 0, y: -10 }}
                animate={{ opacity: 1, y: 0 }}
                className="flex items-center gap-2 p-3 bg-red-900/30 border border-red-500/30 rounded-lg text-red-300 text-sm"
              >
                <AlertCircle size={16} />
                {error}
              </motion.div>
            )}
          </div>

          {/* Footer */}
          <div className="px-6 py-4 border-t border-gray-700 flex items-center justify-between gap-3">
            <button
              onClick={handleTestConnection}
              disabled={testing || !isFormValid}
              className="px-4 py-2 bg-gray-700 hover:bg-gray-600 disabled:bg-gray-800 disabled:text-gray-500 text-white rounded-lg text-sm transition-colors flex items-center gap-2"
            >
              {testing ? (
                <>
                  <Loader2 size={14} className="animate-spin" />
                  Testing...
                </>
              ) : (
                'Test Connection'
              )}
            </button>

            <div className="flex gap-3">
              <button
                onClick={onClose}
                className="px-4 py-2 bg-gray-700 hover:bg-gray-600 text-white rounded-lg text-sm transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleConnect}
                disabled={loading || !isFormValid}
                className="px-6 py-2 bg-cyan-600 hover:bg-cyan-500 disabled:bg-cyan-800 disabled:cursor-not-allowed text-white rounded-lg text-sm transition-colors flex items-center gap-2"
              >
                {loading ? (
                  <>
                    <Loader2 size={14} className="animate-spin" />
                    Connecting...
                  </>
                ) : (
                  'Connect'
                )}
              </button>
            </div>
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  );
};

export default ERPNextConnectModal;
